import { describe, expect, it } from "vitest";
import { guardOversizedMerges } from "./l1-dedup.js";
import type { DedupDecision } from "./l1-writer.js";

describe("guardOversizedMerges", () => {
  const long = "x".repeat(601);

  it("stores instead of merging when the merged text is too long", () => {
    const out = guardOversizedMerges([{ record_id: "n1", action: "merge", target_ids: ["o1", "o2"], merged_content: long }]);
    expect(out).toEqual([{ record_id: "n1", action: "store", target_ids: [] }]);
  });

  it("applies to update too", () => {
    expect(guardOversizedMerges([{ record_id: "n1", action: "update", target_ids: ["o1"], merged_content: long }])[0].action).toBe("store");
  });

  it("keeps short merges and other actions unchanged", () => {
    const keep: DedupDecision[] = [
      { record_id: "a", action: "merge", target_ids: ["o"], merged_content: "x".repeat(600) },
      { record_id: "b", action: "skip", target_ids: [] },
      { record_id: "c", action: "store", target_ids: [] },
    ];
    expect(guardOversizedMerges(keep)).toEqual(keep);
  });
});
