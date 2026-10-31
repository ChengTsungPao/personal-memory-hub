import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { buildGenerationLogIdentity, MemoryGenerationLogStore } from "./store.js";
import type { MemoryGenerationLayer, MemoryGenerationLog } from "./types.js";

async function writeLog(store: MemoryGenerationLogStore, layer: MemoryGenerationLayer, at: number, refs: MemoryGenerationLog["input_refs"]) {
  const id = buildGenerationLogIdentity(layer, at, `m_${at}`);
  await store.write({ log_id: id.logId, layer, instance_id: "default", input_refs: refs } as MemoryGenerationLog, id.key);
}

describe("MemoryGenerationLogStore.listL1InputL0Ids", () => {
  it("collects the L0 inputs of every L1 log and ignores other layers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mglog-"));
    const store = new MemoryGenerationLogStore(new StorageAdapter(new LocalStorageBackend(dir)), "default");
    await writeLog(store, "l1", 1_793_000_000_000, [{ layer: "l0", record_id: "a" }, { layer: "l0", record_id: "b" }]);
    await writeLog(store, "l1", 1_793_100_000_000, [{ layer: "l0", record_id: "c" }]);
    await writeLog(store, "l2", 1_793_100_000_000, [{ layer: "l1", record_id: "x" }]);
    expect([...await store.listL1InputL0Ids()].sort()).toEqual(["a", "b", "c"]);
  });
});
