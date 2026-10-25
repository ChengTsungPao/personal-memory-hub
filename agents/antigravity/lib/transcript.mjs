/**
 * Reads an Antigravity transcript (JSONL) and turns new steps into MemoryCore
 * L0 messages.
 *
 * Transcript shape (`transcriptPath` in the hook payload, `transcript.jsonl`):
 *   - one JSON object per line: { step_index, source, type, status, created_at,
 *     content, tool_calls? }
 *   - `type: "USER_INPUT"`       -> the user's turn. `content` wraps the text in
 *                                   <USER_REQUEST>...</USER_REQUEST> plus
 *                                   <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE>
 *                                   blocks that are harness noise.
 *   - `type: "PLANNER_RESPONSE"` -> the assistant's prose (tool calls ride along
 *                                   in `tool_calls` and are not captured).
 *   - everything else (SYSTEM_MESSAGE, tool steps, ...) is skipped.
 *
 * The cursor is the last `step_index` shipped; cursor persistence is shared
 * with the Claude Code adapter (it stores any string per session id).
 */

import fs from "node:fs";

export { readCursor, writeCursor } from "../../claude-code/lib/transcript.mjs";

const MAX_CONTENT = 8192; // MemoryCore caps message content at 8192 chars.

function userText(content) {
  const requests = [...content.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g)].map((m) => m[1]);
  if (requests.length > 0) return requests.join("\n").trim();
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

/**
 * @param {string} transcriptPath
 * @param {string|null} afterStep  Only return steps after this cursor.
 *                                 Supports line-based cursor ("L:<lineIndex>") or legacy step_index.
 * @returns {{messages: Array, lastUuid: string|null, scanned: number}}
 */
export function readNewMessages(transcriptPath, afterStep) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");

  let afterLine = -1;
  if (afterStep != null) {
    if (typeof afterStep === "string" && afterStep.startsWith("L:")) {
      const parsed = parseInt(afterStep.slice(2), 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed < lines.length) {
        afterLine = parsed;
      }
    } else {
      const targetIdx = Number(afterStep);
      if (!Number.isNaN(targetIdx)) {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].trim()) continue;
          try {
            const o = JSON.parse(lines[i]);
            if (o.step_index === targetIdx) {
              afterLine = i;
              break;
            }
          } catch {}
        }
      }
    }
  }

  const messages = [];
  let lastLine = afterLine >= 0 ? afterLine : -1;
  let scanned = 0;

  for (let i = afterLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    scanned += 1;
    lastLine = i;

    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue; // partially flushed final line
    }

    let role;
    let text = "";
    if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT") {
      role = "user";
      text = userText(String(step.content ?? ""));
    } else if (step.type === "PLANNER_RESPONSE") {
      role = "assistant";
      text = String(step.content ?? "").trim();
    } else {
      continue;
    }
    if (!text) continue;

    const when = step.created_at ? new Date(step.created_at).toISOString() : new Date().toISOString();
    messages.push({
      role,
      content: text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 3)}...` : text,
      timestamp: when,
      recorded_at: when,
    });
  }

  const lastUuid = lastLine >= 0 ? `L:${lastLine}` : null;
  return { messages, lastUuid, scanned };
}
