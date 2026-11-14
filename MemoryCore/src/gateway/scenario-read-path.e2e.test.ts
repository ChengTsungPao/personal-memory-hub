/**
 * E2E: /v3/scenario/read takes the filename that /v3/scenario/ls returns, and also the
 * `scene_blocks/<file>` form that older persona.md navigation listed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { post, startE2EGateway, stopE2EGateway, type E2EContext } from "./chat-memory-e2e-helpers.js";

let ctx: E2EContext;

beforeAll(async () => {
  ctx = await startE2EGateway("scenario-read-path");
  // Requests without team/agent ids land in the default team/agent scope.
  const dir = path.join(ctx.tmpDir, "profiles", encodeURIComponent("team:default|agent:default"), "scene_blocks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deploy.md"), "-----META-START-----\nsummary: s\n-----META-END-----\n\n## 工作場景\nx\n");
});

afterAll(async () => {
  await stopE2EGateway();
});

describe("scenario/read path forms", () => {
  it.each(["deploy.md", "scene_blocks/deploy.md"])("reads %s", async (p) => {
    const res = await post<{ content: string | null }>("/v3/scenario/read", { path: p });
    expect(res.body.code).toBe(0);
    expect(res.body.data!.content).toContain("工作場景");
  });
});
