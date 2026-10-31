import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMRunParams, LLMRunner } from "../types.js";
import { L1ExtractionError, extractL1Memories } from "./l1-extractor.js";

const messages = [
  { id: "m1", role: "user" as const, content: "We decided to deploy the gateway with Docker Compose on Friday.", timestamp: 1_700_000_000_000 },
  { id: "m2", role: "assistant" as const, content: "Noted: the gateway is deployed with Docker Compose, release on Friday.", timestamp: 1_700_000_001_000 },
];

function runner(fail: Error): LLMRunner & { calls: LLMRunParams[] } {
  const calls: LLMRunParams[] = [];
  return { calls, run: async (p: LLMRunParams) => { calls.push(p); throw fail; } };
}

describe("L1 extraction failures", () => {
  it("throws instead of reporting an empty success, so the cursor does not move", async () => {
    const llm = runner(new Error("LLM job j1 suspended after 5 attempts (timeout): timed out"));
    const dir = await mkdtemp(path.join(os.tmpdir(), "l1-"));
    await expect(extractL1Memories({
      messages, sessionKey: "k", sessionId: "s1", baseDir: dir, config: undefined,
      options: { llmRunner: llm, job: { priority: "normal", dedupKey: "L1:s1:0_9" } },
    })).rejects.toBeInstanceOf(L1ExtractionError);
    expect(llm.calls[0]).toMatchObject({ priority: "normal", dedupKey: "L1:s1:0_9:extract" });
  });

  it("a job the user discarded in the gateway is skipped on purpose", async () => {
    const discarded = Object.assign(new Error("LLM job j1 was discarded in the gateway"), { name: "LlmJobDiscardedError" });
    const dir = await mkdtemp(path.join(os.tmpdir(), "l1-"));
    const r = await extractL1Memories({
      messages, sessionKey: "k", sessionId: "s1", baseDir: dir, config: undefined,
      options: { llmRunner: runner(discarded) },
    });
    expect(r).toMatchObject({ success: true, extractedCount: 0, storedCount: 0 });
  });

  it("a batch longer than 10 messages is extracted in full, none left as background", async () => {
    const batch = Array.from({ length: 13 }, (_, i) => ({
      id: `b${i + 1}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `Step ${i + 1} of the gateway rollout plan is documented in the runbook.`, timestamp: 1_700_000_000_000 + i * 1000,
    }));
    const llm = runner(new Error("stop after capturing the prompt"));
    const dir = await mkdtemp(path.join(os.tmpdir(), "l1-"));
    await expect(extractL1Memories({
      messages: batch, sessionKey: "k", sessionId: "s1", baseDir: dir, config: undefined, options: { llmRunner: llm },
    })).rejects.toBeInstanceOf(L1ExtractionError);
    const [background, fresh] = llm.calls[0].prompt.split("【待提取的新消息】");
    for (const m of batch) expect(fresh).toContain(`[${m.id}]`);
    expect(background).not.toContain("[b1]");
  });
});
