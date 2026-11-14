/**
 * E2E: /v3/scenario/read records agent use of an L2 file, /v3/scenario/ls reports it and the
 * expired flag, and `track: false` (the panel viewing a file) does not count as use.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { post, startE2EGateway, stopE2EGateway, type E2EContext } from "./chat-memory-e2e-helpers.js";

interface LsEntry { path: string; last_used_at?: string; expired?: boolean }

let ctx: E2EContext;
let usageFile: string;

beforeAll(async () => {
  ctx = await startE2EGateway("scene-usage");
  // Requests without team/agent ids land in the default team/agent scope.
  const profile = path.join(ctx.tmpDir, "profiles", encodeURIComponent("team:default|agent:default"));
  fs.mkdirSync(path.join(profile, "scene_blocks"), { recursive: true });
  const old = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(profile, "scene_blocks", "old.md"),
    `-----META-START-----\ncreated: ${old}\nupdated: ${old}\nsummary: s\nheat: 1\n-----META-END-----\n\n## 工作場景\nx\n`,
  );
  // No scene_index.json here, so ls falls back to the file's mtime for created/updated.
  fs.utimesSync(path.join(profile, "scene_blocks", "old.md"), new Date(old), new Date(old));
  usageFile = path.join(profile, ".metadata", "scene_usage.json");
});

afterAll(async () => {
  await stopE2EGateway();
});

async function ls(): Promise<LsEntry> {
  const res = await post<{ entries: LsEntry[] }>("/v3/scenario/ls", {});
  expect(res.body.code).toBe(0);
  return res.body.data!.entries.find((e) => e.path === "old.md")!;
}

describe("scene usage over HTTP", () => {
  it("marks a file untouched for 30 days as expired", async () => {
    expect(await ls()).toMatchObject({ expired: true });
    expect(fs.existsSync(usageFile)).toBe(false);
  });

  it("does not count a read with track: false", async () => {
    const res = await post<{ content: string }>("/v3/scenario/read", { path: "old.md", track: false });
    expect(res.body.data!.content).toContain("工作場景");
    expect((await ls()).expired).toBe(true);
  });

  it("counts an agent read and clears expired", async () => {
    await post("/v3/scenario/read", { path: "old.md" });
    const entry = await ls();
    expect(entry.expired).toBe(false);
    expect(Date.now() - Date.parse(entry.last_used_at!)).toBeLessThan(60_000);
  });
});
