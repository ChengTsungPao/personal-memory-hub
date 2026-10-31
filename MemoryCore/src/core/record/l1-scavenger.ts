/**
 * Idle scavenger: give conversation that L1 passed over a second chance.
 *
 * Before the async job queue, an L1 call that timed out was reported as an empty success and the
 * session's cursor moved past it, so that stretch of conversation was never extracted. The scavenger
 * walks each session's L0 history up to its L1 cursor in small windows. A message is extracted when an
 * L1 generation log lists it as a new message (`input_refs`); copies of one message (same session,
 * role, text and recorded_at) count as one. The messages no log lists are extracted again in chunks of
 * at most 10, each with up to 5 earlier messages as background, with priority `idle_only` — the LLM
 * gateway runs it only when nothing else needs the GPU — and the memories go through the normal L1
 * dedup like any L1 result. The session's L1 cursor is never touched.
 *
 * Its own progress (`scavenged_until` per session) is kept in `.metadata/l1-scavenger.json`, so every
 * window is looked at once: a chunk that legitimately yields no memories (and so writes no log) is not
 * retried forever.
 */

import type { IMemoryStore } from "../store/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { shouldExtractL1 } from "../../utils/sanitize.js";

export const SCAVENGER_STATE_PATH = ".metadata/l1-scavenger.json";

export interface ScavengerState {
  version: 1;
  sessions: Record<string, { scavenged_until: number; last_run?: string }>;
}

export interface ScavengerWindowMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  recordedAtMs: number;
  sessionId: string;
  teamId?: string;
  taskId?: string;
  userId: string;
  agentId: string;
}

export function emptyScavengerState(): ScavengerState {
  return { version: 1, sessions: {} };
}

export async function loadScavengerState(dataDir: string, storage?: StorageAdapter): Promise<ScavengerState> {
  try {
    let raw: string | null;
    if (storage) {
      raw = await storage.readFile(SCAVENGER_STATE_PATH);
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      raw = await fs.readFile(path.join(dataDir, SCAVENGER_STATE_PATH), "utf-8");
    }
    const parsed = raw ? (JSON.parse(raw) as ScavengerState) : undefined;
    return parsed && parsed.version === 1 && parsed.sessions ? parsed : emptyScavengerState();
  } catch {
    return emptyScavengerState();
  }
}

export async function saveScavengerState(dataDir: string, state: ScavengerState, storage?: StorageAdapter): Promise<void> {
  const text = JSON.stringify(state, null, 2);
  if (storage) {
    await storage.writeFile(SCAVENGER_STATE_PATH, text);
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const file = path.join(dataDir, SCAVENGER_STATE_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf-8");
}

/**
 * The next window of at most `size` messages after `from` and at or before `cursor` (ascending by
 * recordedAtMs; messages that share the boundary millisecond stay together, like the L1 runner does).
 */
export async function nextWindow(
  store: IMemoryStore,
  sessionKey: string,
  from: number,
  cursor: number,
  size: number,
): Promise<ScavengerWindowMessage[]> {
  const groups = await store.queryL0GroupedBySessionId(sessionKey, from > 0 ? from : undefined, size * 4);
  const flat: ScavengerWindowMessage[] = [];
  for (const g of groups) {
    for (const m of g.messages) {
      if (m.recordedAtMs > cursor) continue;
      flat.push({
        id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, recordedAtMs: m.recordedAtMs,
        sessionId: g.sessionId, teamId: g.teamId, taskId: g.taskId, userId: g.userId, agentId: g.agentId,
      });
    }
  }
  flat.sort((a, b) => (a.recordedAtMs - b.recordedAtMs) || (a.timestamp - b.timestamp));
  let end = Math.min(size, flat.length);
  if (end < flat.length) {
    const boundary = flat[end - 1].recordedAtMs;
    while (end < flat.length && flat[end].recordedAtMs === boundary) end++;
  }
  return flat.slice(0, end);
}

/** One extraction to run: `messages` are extracted, `background` is context only. */
export interface ScavengerChunk {
  sessionId: string;
  teamId?: string;
  taskId?: string;
  userId: string;
  agentId: string;
  background: ScavengerWindowMessage[];
  messages: ScavengerWindowMessage[];
}

const CHUNK_SIZE = 10;
const BACKGROUND_SIZE = 5;

/**
 * Plan the extractions for one window. Per isolation tuple (user, agent, session — like the L1 runner),
 * copies of a message collapse into one; a message any copy of which is in `extracted` is context, and
 * each run of the others is cut into chunks of at most 10, each carrying the 5 messages before it as
 * background. `context` holds those last messages per tuple across windows of one session (updated in
 * place). Messages the L1 quality gate drops are skipped, so the extractor sees exactly these counts.
 */
export function planGapChunks(
  window: ScavengerWindowMessage[],
  extracted: ReadonlySet<string>,
  context: Map<string, ScavengerWindowMessage[]>,
): ScavengerChunk[] {
  const keyOf = (m: ScavengerWindowMessage) => `${m.userId}\u0000${m.agentId}\u0000${m.sessionId}`;
  const sig = (m: ScavengerWindowMessage) => `${keyOf(m)}\u0000${m.recordedAtMs}\u0000${m.role}\u0000${m.content}`;
  const done = new Set(window.filter((m) => extracted.has(m.id)).map(sig));
  const chunks: ScavengerChunk[] = [];
  const runs = new Map<string, ScavengerWindowMessage[]>();
  const seen = new Set<string>();
  const flush = (key: string, m: ScavengerWindowMessage) => {
    const run = runs.get(key) ?? [];
    for (let i = 0; i < run.length; i += CHUNK_SIZE) {
      const history = context.get(key) ?? [];
      const messages = run.slice(i, i + CHUNK_SIZE);
      chunks.push({
        sessionId: m.sessionId, teamId: m.teamId, taskId: m.taskId, userId: m.userId, agentId: m.agentId,
        background: history.slice(-BACKGROUND_SIZE), messages,
      });
      context.set(key, [...history, ...messages].slice(-BACKGROUND_SIZE));
    }
    runs.set(key, []);
  };
  for (const m of window) {
    const key = keyOf(m);
    const s = sig(m);
    if (seen.has(s) || !shouldExtractL1(m.content)) continue;
    seen.add(s);
    if (done.has(s)) {
      flush(key, m);
      context.set(key, [...(context.get(key) ?? []), m].slice(-BACKGROUND_SIZE));
    } else {
      runs.set(key, [...(runs.get(key) ?? []), m]);
    }
  }
  for (const m of window) {
    if (runs.get(keyOf(m))?.length) flush(keyOf(m), m);
  }
  return chunks;
}
