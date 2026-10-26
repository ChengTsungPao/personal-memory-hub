/**
 * Idle scavenger: give conversation that L1 passed over a second chance.
 *
 * Before the async job queue, an L1 call that timed out was reported as an empty success and the
 * session's cursor moved past it, so that stretch of conversation was never extracted. The scavenger
 * walks each session's L0 history up to its L1 cursor in small windows. A window that no L1 memory
 * covers (no L1 record of the session whose conversation time overlaps it) is extracted again with
 * priority `idle_only` — the LLM gateway runs it only when nothing else needs the GPU — and its memories
 * are written like any L1 result. The session's L1 cursor is never touched.
 *
 * Its own progress (`scavenged_until` per session) is kept in `.metadata/l1-scavenger.json`, so every
 * window is looked at once: a window that legitimately yields no memories is not retried forever.
 */

import type { IMemoryStore, L1RecordRow } from "../store/types.js";
import type { StorageAdapter } from "../storage/adapter.js";

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

function toMs(value: string | number | undefined): number {
  if (value === undefined || value === "") return NaN;
  if (typeof value === "number") return value;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && /^\d+$/.test(value) ? asNumber : Date.parse(value);
}

/** Does an L1 record of this session cover any part of the window's conversation time? */
export function isWindowCovered(window: ScavengerWindowMessage[], l1: L1RecordRow[]): boolean {
  if (window.length === 0) return true;
  const start = Math.min(...window.map((m) => m.timestamp));
  const end = Math.max(...window.map((m) => m.timestamp));
  const sessions = new Set(window.map((m) => m.sessionId));
  return l1.some((r) => {
    if (r.session_id && !sessions.has(r.session_id)) return false;
    const rs = toMs(r.timestamp_start || r.timestamp_str);
    const re = toMs(r.timestamp_end || r.timestamp_start || r.timestamp_str);
    if (!Number.isFinite(rs) && !Number.isFinite(re)) return false;
    const lo = Number.isFinite(rs) ? rs : re;
    const hi = Number.isFinite(re) ? re : rs;
    return lo <= end && hi >= start;
  });
}

/** Split a window by the same isolation tuple the L1 runner uses. */
export function groupWindow(window: ScavengerWindowMessage[]): Array<{
  sessionId: string; teamId?: string; taskId?: string; userId: string; agentId: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: number }>;
}> {
  const map = new Map<string, ReturnType<typeof groupWindow>[number]>();
  for (const m of window) {
    const key = `${m.userId}\u0000${m.agentId}\u0000${m.sessionId}`;
    let g = map.get(key);
    if (!g) {
      g = { sessionId: m.sessionId, teamId: m.teamId, taskId: m.taskId, userId: m.userId, agentId: m.agentId, messages: [] };
      map.set(key, g);
    }
    g.messages.push({ id: m.id, role: m.role as "user" | "assistant", content: m.content, timestamp: m.timestamp });
  }
  return [...map.values()];
}
