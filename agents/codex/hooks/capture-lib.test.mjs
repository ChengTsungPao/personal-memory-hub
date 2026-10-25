// Run: node --test agents/codex/hooks/capture-lib.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseTurns, textContent } from "./capture-lib.mjs";

const event = (type, text, id, ts = "2026-10-24T10:00:00Z") => JSON.stringify({
  type: "event_msg", timestamp: ts,
  payload: { type: "item_completed", item: { type, id, content: [{ type: type === "AgentMessage" ? "Text" : "text", text }] } },
});
const response = (role, text, id) => JSON.stringify({
  type: "response_item", payload: { type: "message", role, id, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});

test("uses event messages once; the same message in response_item is not repeated", () => {
  const lines = [
    response("user", "# AGENTS.md instructions for x", "u0"),
    event("UserMessage", "hello", "u1"), response("user", "hello", "r1"),
    event("AgentMessage", "hi there", "a1"), response("assistant", "hi there", "a1"),
  ];
  const { messages } = parseTurns(lines);
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [["user", "hello"], ["assistant", "hi there"]]);
});

test("older files without events: response_item is used, injected context is skipped", () => {
  const lines = [
    response("user", "# AGENTS.md instructions for x", "u0"),
    response("user", "<environment_context>cwd</environment_context>", "u1"),
    response("user", "real question", "u2"), response("assistant", "answer", "a1"),
  ];
  const { messages } = parseTurns(lines);
  assert.deepEqual(messages.map((m) => m.content), ["real question", "answer"]);
});

test("resumes after the last line read; an unfinished last line waits for the next run", () => {
  const lines = [event("UserMessage", "one", "u1"), event("AgentMessage", "two", "a1"), '{"type":"event_msg","pay'];
  const first = parseTurns(lines);
  assert.equal(first.messages.length, 2);
  assert.equal(first.resume, 2);                       // the broken line is not consumed
  lines[2] = event("UserMessage", "three", "u2");
  const next = parseTurns(lines, first.resume);
  assert.deepEqual(next.messages.map((m) => m.content), ["three"]);
  assert.equal(next.resume, 3);
});

test("long text is cut, non-text parts are ignored", () => {
  assert.equal(textContent([{ type: "image" }, { type: "text", text: " a " }]), "a");
  const { messages } = parseTurns([event("UserMessage", "x".repeat(9000), "u1")]);
  assert.equal(messages[0].content.length, 8192);
  assert.ok(messages[0].content.endsWith("..."));
});
