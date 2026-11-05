import { describe, expect, it } from "vitest";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt } from "./l1-dedup.js";

const newMemory = {
  record_id: "new-1",
  content: "PR #31 修正 hooks.json 路徑",
  type: "work_artifact" as const,
  priority: 80,
  source_message_ids: ["msg-1"],
  metadata: {},
  scene_name: "Windows hooks",
};

describe("l1 dedup prompt", () => {
  it("gives the model each new memory's source_time, so an old conversation cannot overwrite newer memory", () => {
    const prompt = formatBatchConflictPrompt([
      { newMemory: { ...newMemory, source_time: "2026-10-25T18:57:48.000Z" }, candidates: [] },
    ]);
    expect(prompt).toContain('"source_time": "2026-10-25T18:57:48.000Z"');
    expect(prompt).toContain("【關聯候選 ID】");
  });

  it("leaves source_time out when it is unknown", () => {
    expect(formatBatchConflictPrompt([{ newMemory, candidates: [] }])).not.toContain("source_time");
  });

  it("work mode keeps details and stores by default", () => {
    const prompt = getConflictDetectionSystemPrompt("code");
    expect(prompt).toContain("所有具體細節都必須保留");
    expect(prompt).toContain("預設 store");
    expect(prompt).toContain("source_time");
    expect(prompt).not.toContain("策略倾向");
    expect(prompt).not.toContain("信息尽量不冗余");
  });
});
