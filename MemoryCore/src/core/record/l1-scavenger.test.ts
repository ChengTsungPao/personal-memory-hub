import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IMemoryStore, L0SessionGroup } from "../store/types.js";
import {
  loadScavengerState,
  nextWindow,
  planGapChunks,
  saveScavengerState,
  type ScavengerWindowMessage,
} from "./l1-scavenger.js";

function msg(i: number, recordedAtMs = i * 1000, sessionId = "s1"): ScavengerWindowMessage {
  return {
    id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `message ${i}`, timestamp: 1_700_000_000_000 + i * 1000,
    recordedAtMs, sessionId, userId: "u", agentId: "a",
  };
}

const ids = (ms: ScavengerWindowMessage[]) => ms.map((m) => m.id);

function fakeStore(messages: ScavengerWindowMessage[]): IMemoryStore {
  return {
    queryL0GroupedBySessionId(_key: string, after?: number, limit?: number): L0SessionGroup[] {
      const rows = messages.filter((m) => after === undefined || m.recordedAtMs > after).slice(0, limit);
      return rows.length ? [{ sessionId: "s1", userId: "u", agentId: "a", messages: rows }] : [];
    },
  } as unknown as IMemoryStore;
}

describe("L1 scavenger helpers", () => {
  it("walks the history below the cursor in windows, keeping same-ms siblings together", async () => {
    const all = [msg(1), msg(2), msg(3, 3000), msg(4, 3000), msg(5), msg(6)];
    const store = fakeStore(all);
    const first = await nextWindow(store, "k", 0, 5000, 3);
    expect(first.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);     // m4 shares m3's millisecond
    const second = await nextWindow(store, "k", 3000, 5000, 3);
    expect(second.map((m) => m.id)).toEqual(["m5"]);                     // m6 is past the cursor
  });

  it("extracts only the messages no L1 log took, with the messages before them as background", () => {
    const w = Array.from({ length: 9 }, (_, i) => msg(i + 1));
    const chunks = planGapChunks(w, new Set(["m1", "m2", "m3", "m4", "m5", "m6", "m9"]), new Map());
    expect(chunks.map((c) => [ids(c.background), ids(c.messages)])).toEqual([
      [["m2", "m3", "m4", "m5", "m6"], ["m7", "m8"]],
    ]);
  });

  it("cuts a long gap into chunks of 10, each with the 5 messages before it", () => {
    const w = Array.from({ length: 23 }, (_, i) => msg(i + 1));
    const chunks = planGapChunks(w, new Set(["m1", "m2"]), new Map());
    expect(chunks.map((c) => [ids(c.background), ids(c.messages)])).toEqual([
      [["m1", "m2"], ids(w.slice(2, 12))],
      [ids(w.slice(7, 12)), ids(w.slice(12, 22))],
      [ids(w.slice(17, 22)), ["m23"]],
    ]);
  });

  it("treats copies of one message as one, extracted if any copy was", () => {
    const copy = (m: ScavengerWindowMessage, id: string) => ({ ...m, id });
    const w = [msg(1), copy(msg(1), "m1b"), msg(2), copy(msg(2), "m2b"), copy(msg(2), "m2c")];
    const chunks = planGapChunks(w, new Set(["m1b"]), new Map());
    expect(chunks.map((c) => [ids(c.background), ids(c.messages)])).toEqual([[["m1"], ["m2"]]]);
  });

  it("keeps sessions apart and carries background into the next window", () => {
    const context = new Map<string, ScavengerWindowMessage[]>();
    expect(planGapChunks([msg(1), msg(2, 2000, "s2")], new Set(["m1"]), context)
      .map((c) => [c.sessionId, ids(c.background), ids(c.messages)])).toEqual([["s2", [], ["m2"]]]);
    expect(planGapChunks([msg(3)], new Set(), context).map((c) => ids(c.background))).toEqual([["m1"]]);
  });

  it("keeps its progress across runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scavenger-"));
    expect(await loadScavengerState(dir)).toEqual({ version: 1, sessions: {} });
    await saveScavengerState(dir, { version: 1, sessions: { k: { scavenged_until: 42 } } });
    expect((await loadScavengerState(dir)).sessions.k.scavenged_until).toBe(42);
  });
});
