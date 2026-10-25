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

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" || part?.type === "input_text" || part?.type === "output_text")
    .map((part) => part.text).filter((text) => typeof text === "string").join("\n").trim();
}

function messageFrom(entry) {
  const payload = entry?.payload;
  let role;
  let content;
  let id;
  if (entry?.type === "event_msg" && payload?.type === "item_completed") {
    const item = payload.item;
    role = item?.type === "UserMessage" ? "user" : item?.type === "AgentMessage" ? "assistant" : null;
    content = textContent(item?.content);
    id = item?.id;
  } else if (entry?.type === "response_item" && payload?.type === "message") {
    role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
    content = textContent(payload.content);
    id = payload.id;
  }
  if (!role || !content) return null;
  const when = entry.timestamp && !Number.isNaN(Date.parse(entry.timestamp))
    ? new Date(entry.timestamp).toISOString() : new Date().toISOString();
  return { role, content: content.length > 8192 ? `${content.slice(0, 8189)}...` : content, timestamp: when, recorded_at: when, id };
}

function findTranscript(sessionId) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  if (!fs.existsSync(root)) return null;
  const files = [];
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.isFile() && item.name.endsWith(".jsonl")) files.push(full);
    }
  };
  visit(root);
  for (const file of files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)) {
    try {
      if (fs.readFileSync(file, "utf8").includes(`"thread_id":"${sessionId}"`)) return file;
    } catch { /* ignore a file being rotated */ }
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
  const start = readCursor(cfg.stateDir, sessionId);
  const messages = [];
  const seen = new Set();
  let lastLine = start;
  for (let i = start; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    lastLine = i + 1;
    const message = messageFrom(entry);
    if (!message || (message.id && seen.has(message.id))) continue;
    if (message.id) seen.add(message.id);
    messages.push(message);
  }
  if (!messages.length) return writeCursor(cfg.stateDir, sessionId, lastLine);

  const client = new CoreClient({ ...cfg, timeoutMs: cfg.captureTimeoutMs });
  const accepted = await client.addConversation(sessionId, messages.map(({ id, ...message }) => message));
  debugLog(cfg, `captured ${accepted}/${messages.length} messages for ${sessionId}`);
  writeCursor(cfg.stateDir, sessionId, lastLine);
}

main().catch((err) => {
  if (process.env.TDAI_DEBUG === "1") console.error("[tdai-hook] Codex capture failed:", err?.message ?? err);
}).finally(() => process.exit(0));
