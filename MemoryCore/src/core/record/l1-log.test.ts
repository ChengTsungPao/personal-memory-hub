import { describe, expect, it } from "vitest";
import { assignL1Records, parseL1Log } from "./l1-log.js";

const line = (r: Record<string, unknown>) => JSON.stringify(r);

describe("parseL1Log", () => {
  it("keeps the last version of an id and skips partial lines", () => {
    const log = parseL1Log([
      [line({ id: "a", content: "v0", createdAt: "1" }), '{"id":"b","cont'].join("\n"),
      line({ id: "a", content: "v1", createdAt: "1" }),
    ]);
    expect([...log.keys()]).toEqual(["a"]);
    expect(log.get("a")!.content).toBe("v1");
  });
});

describe("assignL1Records", () => {
  const table = [{ record_id: "live", agent_id: "blk-new", session_key: "s1" }];
  const targets = new Set(["blk-new", "blk-other"]);

  it("assigns a merged-away record to the block that owns its session now", () => {
    const log = parseL1Log([
      [
        line({ id: "gone", content: "detail", createdAt: "2026-10-01", sessionKey: "s1", agentId: "blk-old" }),
        line({ id: "live", content: "merged", createdAt: "2026-10-02", sessionKey: "s1", agentId: "blk-old" }),
      ].join("\n"),
    ]);
    expect(assignL1Records(log, table, targets).map((r) => [r.record_id, r.agent_id])).toEqual([
      ["gone", "blk-new"],
      ["live", "blk-new"],
    ]);
  });

  it("falls back to the log's agentId and drops records outside the targets", () => {
    const log = parseL1Log([
      [
        line({ id: "x", content: "c1", createdAt: "1", sessionKey: "s9", agentId: "blk-other" }),
        line({ id: "y", content: "c2", createdAt: "2", sessionKey: "s9", agentId: "blk-repo" }),
      ].join("\n"),
    ]);
    expect(assignL1Records(log, table, targets).map((r) => r.record_id)).toEqual(["x"]);
  });

  it("drops duplicate content within a block", () => {
    const log = parseL1Log([
      [
        line({ id: "p", content: "same", createdAt: "1", sessionKey: "s1" }),
        line({ id: "q", content: "same", createdAt: "2", sessionKey: "s1" }),
      ].join("\n"),
    ]);
    expect(assignL1Records(log, table, targets).map((r) => r.record_id)).toEqual(["p"]);
  });
});
