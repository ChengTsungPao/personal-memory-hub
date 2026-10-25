#!/usr/bin/env node
/**
 * Codex Stop hook: append the user-visible turns from the Codex JSONL session
 * to MemoryCore L0. This hook is deliberately fail-open.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { loadConfig, debugLog } from "../../claude-code/lib/config.mjs";
import { CoreClient } from "../../claude-code/lib/core-client.mjs";
import { parseTurns } from "./capture-lib.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function cursorFile(stateDir, sessionId) {
  const safe = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(stateDir, `codex-${safe}.cursor`);
}

function readCursor(stateDir, sessionId) {
  try { return Number(fs.readFileSync(cursorFile(stateDir, sessionId), "utf8")) || 0; } catch { return 0; }
}

function writeCursor(stateDir, sessionId, line) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(cursorFile(stateDir, sessionId), String(line), "utf8");
}

/** Rollout files are named `rollout-<time>-<session id>.jsonl`, so no file has to be opened to find one. */
function findTranscript(sessionId) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  if (!sessionId || !fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && item.name.endsWith(`${sessionId}.jsonl`)) return full;
    }
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const sessionId = payload.session_id ?? payload.thread_id;
  const cfg = await loadConfig(payload.cwd);
  const transcriptPath = payload.transcript_path ?? findTranscript(sessionId);
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) {
    return debugLog(cfg, "payload missing session_id or Codex transcript");
  }

  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  const { messages, resume } = parseTurns(lines, readCursor(cfg.stateDir, sessionId));
  if (!messages.length) return writeCursor(cfg.stateDir, sessionId, resume);

  const client = new CoreClient({ ...cfg, timeoutMs: cfg.captureTimeoutMs });
  const accepted = await client.addConversation(sessionId, messages);
  debugLog(cfg, `captured ${accepted}/${messages.length} messages for ${sessionId}`);
  // Nothing accepted: keep the cursor so the next Stop retries instead of dropping the turns.
  if (accepted > 0) writeCursor(cfg.stateDir, sessionId, resume);
}

main().catch((err) => {
  if (process.env.TDAI_DEBUG === "1") console.error("[tdai-hook] Codex capture failed:", err?.message ?? err);
}).finally(() => process.exit(0));
