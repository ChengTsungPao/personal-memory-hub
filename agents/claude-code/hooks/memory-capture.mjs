#!/usr/bin/env node
/**
 * Stop hook — captures the turn that just finished into MemoryCore L0.
 *
 * Reads the hook payload from stdin:
 *   { session_id, prompt_id, transcript_path, cwd, last_assistant_message }
 *
 * Writes only the entries added since the last run (see lib/transcript.mjs),
 * so the repeated Stop events across a long session do not re-send history.
 *
 * **This hook must never interrupt the user.** Every failure path exits 0 with
 * no output: a memory backend that is down, misconfigured, or slow is an
 * inconvenience, not a reason to stop someone's work. Set TDAI_DEBUG=1 to see
 * what it is doing on stderr.
 */

import { loadConfig, debugLog } from "../lib/config.mjs";
import { CoreClient } from "../lib/core-client.mjs";
import { readNewMessages, readCursor, writeCursor } from "../lib/transcript.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = payload.session_id;
  const cfg = loadConfig(payload.cwd, sessionId);

  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) {
    return debugLog(cfg, "payload missing session_id or transcript_path");
  }

  const cursor = readCursor(cfg.stateDir, sessionId);
  const { messages, lastUuid } = readNewMessages(transcriptPath, cursor);

  if (messages.length === 0) {
    debugLog(cfg, "nothing new to capture");
    // Still advance the cursor: the turn may have been pure tool calls, and
    // leaving the cursor behind would re-scan them on every later turn.
    writeCursor(cfg.stateDir, sessionId, lastUuid);
    return;
  }

  const client = new CoreClient(cfg);
  const accepted = await client.addConversation(sessionId, messages);
  debugLog(cfg, `captured ${accepted}/${messages.length} messages for ${sessionId}`);

  // Advance only after a successful write, so a transient failure is retried
  // on the next turn instead of silently dropping the conversation.
  writeCursor(cfg.stateDir, sessionId, lastUuid);
}

main()
  .catch((err) => {
    // Deliberately quiet on stdout — anything printed there is parsed as hook
    // output. Diagnostics go to stderr, and only when debugging is on.
    if (process.env.TDAI_DEBUG === "1") console.error("[tdai-hook] capture failed:", err?.message ?? err);
  })
  .finally(() => process.exit(0));
