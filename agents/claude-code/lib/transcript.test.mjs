// node --test agents/claude-code/lib/transcript.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNewMessages } from "./transcript.mjs";

test("skips background task notices sent as user turns", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  try {
    const file = path.join(dir, "t.jsonl");
    const t = "2026-11-14T07:00:00.000Z";
    const lines = [
      { type: "user", uuid: "u1", timestamp: t, message: { role: "user", content: "目前狀況如何" } },
      { type: "user", uuid: "u2", timestamp: t, message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" } },
      { type: "assistant", uuid: "a1", timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "還在跑" }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const { messages, lastUuid } = readNewMessages(file, null);
    assert.deepEqual(messages.map((m) => m.content), ["目前狀況如何", "還在跑"]);
    assert.equal(lastUuid, "a1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
