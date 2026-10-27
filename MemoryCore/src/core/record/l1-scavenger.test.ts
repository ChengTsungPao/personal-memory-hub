import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IMemoryStore, L0SessionGroup, L1RecordRow } from "../store/types.js";
import {
  groupWindow,
  isWindowCovered,
  loadScavengerState,
  nextWindow,
  saveScavengerState,
  type ScavengerWindowMessage,
} from "./l1-scavenger.js";

function msg(i: number, recordedAtMs = i * 1000, sessionId = "s1"): ScavengerWindowMessage {
  return {
    id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `message ${i}`, timestamp: 1_700_000_000_000 + i * 1000,
    recordedAtMs, sessionId, userId: "u", agentId: "a",
  };
}

function l1(start: number, end: number, sessionId = "s1"): L1RecordRow {
  return {
    record_id: `r${start}`, content: "x", type: "episodic", priority: 50, scene_name: "", session_key: "k",
    session_id: sessionId, team_id: "", task_id: "", user_id: "u", agent_id: "a", version: 1, timestamp_str: "",
    timestamp_start: new Date(start).toISOString(), timestamp_end: new Date(end).toISOString(), created_time: "",
  } as L1RecordRow;
}

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

  it("a window is covered when an L1 record of the session overlaps its conversation time", () => {
    const w = [msg(1), msg(2), msg(3)];
    const [start, end] = [w[0].timestamp, w[2].timestamp];
    expect(isWindowCovered(w, [l1(start + 500, start + 600)])).toBe(true);
    expect(isWindowCovered(w, [l1(end + 1000, end + 2000)])).toBe(false);
    expect(isWindowCovered(w, [l1(start, end, "other-session")])).toBe(false);
    expect(isWindowCovered(w, [])).toBe(false);
    expect(isWindowCovered([], [])).toBe(true);
  });

  it("groups a window by user, agent and session like the L1 runner", () => {
    const groups = groupWindow([msg(1), msg(2, 2000, "s2"), msg(3)]);
    expect(groups.map((g) => [g.sessionId, g.messages.map((m) => m.id)])).toEqual([["s1", ["m1", "m3"]], ["s2", ["m2"]]]);
  });

  it("keeps its progress across runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scavenger-"));
    expect(await loadScavengerState(dir)).toEqual({ version: 1, sessions: {} });
    await saveScavengerState(dir, { version: 1, sessions: { k: { scavenged_until: 42 } } });
    expect((await loadScavengerState(dir)).sessions.k.scavenged_until).toBe(42);
  });
});
