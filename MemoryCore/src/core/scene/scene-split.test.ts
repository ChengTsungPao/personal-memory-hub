import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SceneExtractor, SPLIT_SCENE_CHARS } from "./scene-extractor.js";
import { formatSceneBlock } from "./scene-format.js";
import { syncSceneIndex } from "./scene-index.js";

async function promptFor(contentChars: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "split-"));
  await mkdir(path.join(dir, "scene_blocks"), { recursive: true });
  const meta = { created: "2026-11-01T00:00:00.000Z", updated: "2026-11-01T00:00:00.000Z", summary: "s", heat: 1 };
  await writeFile(path.join(dir, "scene_blocks", "big.md"), formatSceneBlock(meta, "x".repeat(contentChars)), "utf-8");
  await syncSceneIndex(dir);
  let prompt = "";
  const runner = { run: async (p: { prompt: string }) => { prompt = p.prompt; return ""; } };
  await new SceneExtractor({ dataDir: dir, config: undefined, promptMode: "code", llmRunner: runner as never }).extract([
    { content: "a memory", created_at: "2026-11-02T00:00:00.000Z", id: "m1" },
  ]);
  return prompt;
}

describe("oversized scene split request", () => {
  it("names a scene file past the limit and asks for a split", async () => {
    const prompt = await promptFor(SPLIT_SCENE_CHARS + 1);
    expect(prompt).toContain("`big.md`");
    expect(prompt).toContain("拆成 2–3 個");
  });

  it("says nothing for a file within the limit", async () => {
    expect(await promptFor(SPLIT_SCENE_CHARS)).not.toContain("拆成 2–3 個");
  });
});
