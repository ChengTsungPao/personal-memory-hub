import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../storage/adapter.js";
import { isSceneExpired, lastActivity, markSceneUsed, readSceneUsage } from "./scene-usage.js";

function memoryStorage(): StorageAdapter {
  const files = new Map<string, string>();
  return {
    readFile: async (key: string) => files.get(key) ?? null,
    writeFile: async (key: string, content: string) => void files.set(key, content),
  } as unknown as StorageAdapter;
}

describe("scene usage", () => {
  it("records the last read per file", async () => {
    const storage = memoryStorage();
    await markSceneUsed(storage, "a.md", new Date("2026-11-01T00:00:00Z"));
    await markSceneUsed(storage, "b.md", new Date("2026-11-02T00:00:00Z"));
    await markSceneUsed(storage, "a.md", new Date("2026-11-03T00:00:00Z"));
    expect(await readSceneUsage(storage)).toEqual({
      "a.md": "2026-11-03T00:00:00.000Z",
      "b.md": "2026-11-02T00:00:00.000Z",
    });
  });

  it("reads a missing or corrupt file as empty", async () => {
    const storage = memoryStorage();
    expect(await readSceneUsage(storage)).toEqual({});
    await storage.writeFile(".metadata/scene_usage.json", "{not json");
    expect(await readSceneUsage(storage)).toEqual({});
  });

  it("expires a file only when neither a read nor an update happened for 30 days", () => {
    const now = new Date("2026-12-31T00:00:00Z");
    const updated = "2026-11-01T00:00:00Z";
    expect(isSceneExpired(lastActivity("2026-10-01T00:00:00Z", updated, undefined), now)).toBe(true);
    expect(isSceneExpired(lastActivity("2026-10-01T00:00:00Z", updated, "2026-12-20T00:00:00Z"), now)).toBe(false);
    expect(isSceneExpired(lastActivity("2026-10-01T00:00:00Z", "2026-12-15T00:00:00Z", undefined), now)).toBe(false);
    expect(isSceneExpired(lastActivity(undefined, "", "bad"), now)).toBe(false);
  });
});
