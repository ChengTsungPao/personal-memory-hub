/**
 * Pure parts of the Codex capture hook (no I/O to MemoryCore), so they can be tested.
 *
 * A Codex rollout file (JSONL) records every message twice: as `event_msg/item_completed`
 * (UserMessage / AgentMessage) and as `response_item/message`. Only the first is what the
 * user and the agent actually said: `response_item` user messages also hold context that
 * Codex injects (AGENTS.md instructions, environment info). So the event form is used when the
 * file has it, and `response_item` only for older files without it.
 */

// Codex writes "text" in user messages but "Text" in agent messages: compare lower-cased.
const TEXT_PARTS = new Set(["text", "input_text", "output_text"]);
const INJECTED = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions instructions>)/;
const MAX_CHARS = 8192;

export function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => TEXT_PARTS.has(String(part?.type).toLowerCase()))
    .map((part) => part.text).filter((text) => typeof text === "string").join("\n").trim();
}

export function hasItemEvents(lines) {
  return lines.some((line) => line.includes('"item_completed"'));
}

export function messageFrom(entry, useEvents) {
  const payload = entry?.payload;
  let role = null;
  let content = "";
  if (useEvents) {
    if (entry?.type !== "event_msg" || payload?.type !== "item_completed") return null;
    const item = payload.item;
    role = item?.type === "UserMessage" ? "user" : item?.type === "AgentMessage" ? "assistant" : null;
    content = textContent(item?.content);
  } else if (entry?.type === "response_item" && payload?.type === "message") {
    role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
    content = textContent(payload.content);
    if (role === "user" && INJECTED.test(content)) return null;
  }
  if (!role || !content) return null;
  const when = entry.timestamp && !Number.isNaN(Date.parse(entry.timestamp))
    ? new Date(entry.timestamp).toISOString() : new Date().toISOString();
  return { role, content: content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS - 3)}...` : content, timestamp: when, recorded_at: when };
}

/** New messages after line `start`, and the line to resume from next time. A last line that does
 *  not parse yet (still being written) is left for the next run. */
export function parseTurns(lines, start = 0) {
  const useEvents = hasItemEvents(lines);
  const messages = [];
  let resume = start;
  for (let i = start; i < lines.length; i += 1) {
    if (!lines[i].trim()) { resume = i + 1; continue; }
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { break; }
    resume = i + 1;
    const message = messageFrom(entry, useEvents);
    if (message) messages.push(message);
  }
  return { messages, resume };
}
