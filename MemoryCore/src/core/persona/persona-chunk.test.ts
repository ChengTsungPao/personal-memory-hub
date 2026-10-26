import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { DEFAULT_MAX_MEMORIES_PER_UPDATE, countMemories } from "./persona-generator.js";

describe("persona chunk limit", () => {
  it("counts the memories of a scene block by its list items", () => {
    expect(countMemories("# Scene\n\n- one\n- two\n* three\n1. four\n\ntext")).toBe(4);
    expect(countMemories("no list at all")).toBe(1);
    expect(DEFAULT_MAX_MEMORIES_PER_UPDATE).toBe(50);
  });

  it("a chunk-limited update records only the time it covered and asks for another update", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "persona-"));
    const cp = new CheckpointManager(dir, undefined as never);
    await cp.markPersonaGenerated(10, { coveredUntil: "2026-10-01T00:00:00.000Z" });
    let state = await cp.read();
    expect(state.last_persona_time).toBe("2026-10-01T00:00:00.000Z");
    expect(state.request_persona_update).toBe(true);

    await cp.markPersonaGenerated(20);                          // everything covered
    state = await cp.read();
    expect(state.request_persona_update).toBe(false);
    expect(Date.parse(state.last_persona_time)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00.000Z"));
  });
});
