import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "./memory-store.js";
import type { IMemoryStore } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { buildFtsQuery } from "../tokenize.js";

// Merging session memory blocks moves one agent's L0 + L1 to another (/v3/chat-memory/merge).
describe("sqlite moveMemoryContent", () => {
  const dirs: string[] = [];
  const open = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "move-mem-"));
    dirs.push(dir);
    const store = new VectorStore(path.join(dir, "vectors.db"), 0); // metadata + FTS only
    store.init();
    return store;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const ts = new Date().toISOString();
  const l0 = (id: string, agentId: string, text: string) =>
    ({ id, sessionKey: "sk", sessionId: `sid-${agentId}`, role: "user", messageText: text, recordedAt: ts, timestamp: Date.now(), teamId: "t", agentId }) as Parameters<IMemoryStore["upsertL0"]>[0];
  const l1 = (id: string, agentId: string, content: string): MemoryRecord =>
    ({ id, content, type: "persona", priority: 50, scene_name: "", source_message_ids: [], metadata: {}, timestamps: [ts], createdAt: ts, updatedAt: ts, sessionKey: "sk", sessionId: `sid-${agentId}`, teamId: "t", agentId }) as MemoryRecord;

  it("re-owns L0 and L1 rows, keeps other agents' rows, and keeps them searchable", async () => {
    const store = open();
    await store.upsertL0(l0("a1", "agt-a", "merge me first"), undefined);
    await store.upsertL0(l0("a2", "agt-a", "merge me second"), undefined);
    await store.upsertL1(l1("a3", "agt-a", "atom about pytest"), undefined);
    await store.upsertL0(l0("b1", "agt-b", "already in b"), undefined);
    await store.upsertL0(l0("c1", "agt-c", "unrelated"), undefined);

    const res = await store.moveMemoryContent!({ teamId: "t", fromAgentId: "agt-a", toAgentId: "agt-b" });

    expect(res).toEqual({ l0Moved: 2, l1Moved: 1 });
    expect(store.countL0({ teamId: "t", agentId: "agt-a" })).toBe(0);
    expect(store.countL0({ teamId: "t", agentId: "agt-b" })).toBe(3);
    expect(store.countL1({ teamId: "t", agentId: "agt-b" })).toBe(1);
    expect(store.countL0({ teamId: "t", agentId: "agt-c" })).toBe(1);
    // The FTS rows moved with them: a keyword search scoped to the new owner finds them.
    const hits = store.searchL0Fts(buildFtsQuery("merge")!, 10, { teamId: "t", agentId: "agt-b" } as never);
    expect(hits.map((h) => h.record_id ?? (h as any).id).sort()).toEqual(["a1", "a2"]);

    // Moving again is a no-op.
    expect(await store.moveMemoryContent!({ teamId: "t", fromAgentId: "agt-a", toAgentId: "agt-b" })).toEqual({ l0Moved: 0, l1Moved: 0 });
  });

  it("refuses an empty id or a move onto itself", async () => {
    const store = open();
    expect(() => store.moveMemoryContent!({ teamId: "t", fromAgentId: "", toAgentId: "agt-b" })).toThrow();
    expect(() => store.moveMemoryContent!({ teamId: "t", fromAgentId: "agt-a", toAgentId: "agt-a" })).toThrow();
  });
});
