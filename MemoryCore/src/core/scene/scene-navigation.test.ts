import { describe, expect, it } from "vitest";
import { generateSceneNavigation } from "./scene-navigation.js";

const entry = { filename: "deploy.md", summary: "s", heat: 1, created: "", updated: "" } as never;

describe("generateSceneNavigation", () => {
  it("lists the filename scenario_read takes when no data dir is given (persona.md)", () => {
    const nav = generateSceneNavigation([entry]);
    expect(nav).toContain("### Path: deploy.md\n");
    expect(nav).toContain("**scenario_read**");
    expect(nav).not.toContain("絕對路徑");
  });

  it("keeps absolute paths and the read tool for a local data dir", () => {
    const nav = generateSceneNavigation([entry], "/data/p");
    expect(nav).toMatch(/### Path: .*scene_blocks.deploy\.md/);
    expect(nav).toContain("**read**");
  });
});
