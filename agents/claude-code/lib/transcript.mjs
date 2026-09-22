/**
 * Reads a Claude Code transcript (JSONL) and turns the new entries into
 * MemoryCore L0 messages.
 *
 * Transcript shape, verified against a real file:
 *   - one JSON object per line, discriminated by `type`
 *   - `type: "user"`      → `message.content` is a **string**, or a block list
 *                           when the entry is a tool result
 *   - `type: "assistant"` → `message.content` is a **block list**; blocks are
 *                           `{type:"thinking"}`, `{type:"text"}`, `{type:"tool_use"}`
 *   - every entry carries `uuid`, `timestamp`, `sessionId`, `isSidechain`
 *   - many other `type` values are bookkeeping (`attachment`, `mode`,
 *     `file-history-snapshot`, …) and are skipped
 *
 * The `Stop` hook fires on EVERY turn, so sending the whole transcript each
 * time would duplicate the entire history on every message. A cursor file
 * records the last uuid that was shipped; only entries after it are sent.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Pull plain text out of a transcript entry, or "" when it carries none. */
function extractText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  // Keep prose only: `thinking` is private reasoning, `tool_use` / `tool_result`
  // are machine payloads that would bloat L0 without adding recall value.
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Parse a transcript into L0-ready messages.
 *
 * @param {string} transcriptPath
 * @param {string|null} afterUuid  Only return entries that appear after this
 *                                 uuid. `null` returns everything.
 * @returns {{messages: Array, lastUuid: string|null, scanned: number}}
 */
export function readNewMessages(transcriptPath, afterUuid) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");

  const messages = [];
  let lastUuid = afterUuid;
  let reached = afterUuid == null;
  let scanned = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line is normal — skip it
    }
    scanned += 1;

    const uuid = entry.uuid;

    // Fast-forward until we pass the cursor.
    if (!reached) {
      if (uuid && uuid === afterUuid) reached = true;
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    // Subagent transcripts are their own conversations; they would pollute the
    // main session's L0 with work the user never saw.
    if (entry.isSidechain) continue;

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(entry);
    if (!text) continue; // pure thinking / tool-call turns carry no prose

    messages.push({
      role,
      // The API caps content at 8192 characters.
      content: text.length > 8192 ? `${text.slice(0, 8189)}...` : text,
      recorded_at: entry.timestamp ?? new Date().toISOString(),
      timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
    });

    if (uuid) lastUuid = uuid;
  }

  // The cursor was not found — the transcript was replaced (a /clear, or a
  // different session reusing the path). Re-read it whole rather than
  // silently capturing nothing from here on.
  if (!reached && afterUuid != null) {
    return readNewMessages(transcriptPath, null);
  }

  return { messages, lastUuid, scanned };
}

// ── Cursor persistence ──────────────────────────────────────────────────

function cursorFile(stateDir, sessionId) {
  // Session ids come from Claude Code and are uuid-shaped, but hash anyway so
  // nothing odd can escape the state directory.
  const safe = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(stateDir, `${safe}.cursor`);
}

export function readCursor(stateDir, sessionId) {
  try {
    const value = fs.readFileSync(cursorFile(stateDir, sessionId), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeCursor(stateDir, sessionId, uuid) {
  if (!uuid) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(cursorFile(stateDir, sessionId), uuid, "utf8");
}
