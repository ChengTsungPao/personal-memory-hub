import { describe, expect, it } from "vitest";
import { restoreDroppedFacts } from "./scene-fact-guard.js";

const META = "-----META-START-----\ncreated: x\n-----META-END-----\n\n";

describe("restoreDroppedFacts", () => {
  const old = new Map([
    ["rakazo.md", "## 核心 SOP\n- 重啟：`docker compose restart web`\n- 埠號 `RAKAZO_WEB_PORT=5273`\n"],
  ]);

  it("puts a silently dropped fact back into 關鍵事實依據", () => {
    const next = new Map([
      ["rakazo.md", `${META}## 核心 SOP\n- 重啟：\`docker compose restart web\`\n\n## 關鍵事實依據\n- 既有\n\n## 演化記錄\n- x\n`],
    ]);
    const { changed, restored } = restoreDroppedFacts(old, next);
    expect(restored).toEqual([{ file: "rakazo.md", term: "RAKAZO_WEB_PORT=5273" }]);
    expect(changed.get("rakazo.md")).toBe(
      `${META}## 核心 SOP\n- 重啟：\`docker compose restart web\`\n\n## 關鍵事實依據\n- 既有\n- 埠號 \`RAKAZO_WEB_PORT=5273\`\n\n## 演化記錄\n- x\n`,
    );
  });

  it("leaves a fact the 演化記錄 retired, and one that moved to another file", () => {
    const next = new Map([
      ["rakazo.md", `${META}## 核心 SOP\n- 新流程\n\n## 演化記錄\n- \`RAKAZO_WEB_PORT=5273\` 已改為 8080\n`],
      ["docker.md", `${META}## 核心 SOP\n- \`docker compose restart web\`\n`],
    ]);
    expect(restoreDroppedFacts(old, next).restored).toEqual([]);
  });

  it("sends facts of a merged-away file to the file sharing most of its terms", () => {
    const next = new Map([
      ["other.md", `${META}## 核心 SOP\n- 無關\n`],
      ["deploy.md", `${META}## 核心 SOP\n- \`docker compose restart web\`\n`],
    ]);
    const { changed, restored } = restoreDroppedFacts(old, next);
    expect(restored).toEqual([{ file: "deploy.md", term: "RAKAZO_WEB_PORT=5273" }]);
    expect(changed.get("deploy.md")).toContain("## 關鍵事實依據\n- 埠號 `RAKAZO_WEB_PORT=5273`");
    expect(changed.has("other.md")).toBe(false);
  });
});
