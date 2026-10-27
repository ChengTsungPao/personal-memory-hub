#!/usr/bin/env node
/**
 * Antigravity `Stop` hook - captures the turn that just finished into
 * MemoryCore L0. Port of agents/claude-code/hooks/memory-capture.mjs.
 *
 * stdin (camelCase protojson): { conversationId, workspacePaths, transcriptPath,
 *   terminationReason, ... }
 * stdout: `{"decision":""}` always (never `"continue"` - this hook must not keep
 * the agent running).
 *
 * Only steps after the stored cursor are sent. Every failure path exits 0:
 * a memory backend that is down is never a reason to interrupt the user.
 * Set TDAI_DEBUG=1 for stderr diagnostics.
 */

import "../lib/env.mjs";
import { debugLog } from "../../claude-code/lib/config.mjs";
import { CoreClient } from "../../claude-code/lib/core-client.mjs";
import { openSession } from "../../claude-code/lib/session.mjs";
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

  const sessionId = payload.conversationId;
  const transcriptPath = payload.transcriptPath;
  // This conversation's own memory block, bound to its repos (claude-code/lib/session.mjs).
  const { cfg, skip } = await openSession(sessionId, payload.workspacePaths?.[0]);
  if (!sessionId || !transcriptPath) {
    return debugLog(cfg, "payload missing conversationId or transcriptPath");
  }
  if (skip) return debugLog(cfg, "no admin key: cannot create this session's memory block");

  const cursor = readCursor(cfg.stateDir, sessionId);
  const { messages, lastUuid } = readNewMessages(transcriptPath, cursor);

  if (messages.length === 0) {
    debugLog(cfg, "nothing new to capture");
    writeCursor(cfg.stateDir, sessionId, lastUuid);
    return;
  }

  const client = new CoreClient({ ...cfg, timeoutMs: cfg.captureTimeoutMs });
  const accepted = await client.addConversation(sessionId, messages);
  debugLog(cfg, `captured ${accepted}/${messages.length} messages for ${sessionId}`);

  // Advance only after a successful write so a transient failure is retried.
  writeCursor(cfg.stateDir, sessionId, lastUuid);
}

main()
  .catch((err) => {
    if (process.env.TDAI_DEBUG === "1") console.error("[tdai-hook] capture failed:", err?.message ?? err);
  })
  .finally(() => {
    process.stdout.write('{"decision":""}');
    process.exit(0);
  });
