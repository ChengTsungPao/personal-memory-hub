import { describe, expect, it } from "vitest";
import { parseSceneBlock, stampSceneMeta } from "./scene-format.js";

const NOW = "2026-11-10T00:00:00.000Z";
const raw = (created: string, updated: string) =>
  `-----META-START-----\ncreated: ${created}\nupdated: ${updated}\nsummary: s\nheat: 3\n-----META-END-----\n\n## 工作場景\nbody`;

describe("stampSceneMeta", () => {
  it("replaces an invented updated date with now", () => {
    const meta = parseSceneBlock(stampSceneMeta(raw("2024-05-22", "2024-05-22"), "a.md", NOW, "2026-10-01T00:00:00.000Z"), "a.md").meta;
    expect(meta.updated).toBe(NOW);
    expect(meta.created).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses now for created when the file is new", () => {
    expect(parseSceneBlock(stampSceneMeta(raw("2024-05-22", "x"), "a.md", NOW), "a.md").meta.created).toBe(NOW);
  });

  it("ignores a previous created time that is not a real past time", () => {
    expect(parseSceneBlock(stampSceneMeta(raw("x", "x"), "a.md", NOW, "{{CURRENT_TIME}}"), "a.md").meta.created).toBe(NOW);
    expect(parseSceneBlock(stampSceneMeta(raw("x", "x"), "a.md", NOW, "2027-01-01T00:00:00.000Z"), "a.md").meta.created).toBe(NOW);
  });

  it("keeps summary, heat and content", () => {
    const block = parseSceneBlock(stampSceneMeta(raw("a", "b"), "a.md", NOW), "a.md");
    expect(block.meta.summary).toBe("s");
    expect(block.meta.heat).toBe(3);
    expect(block.content).toBe("## 工作場景\nbody");
  });
});
