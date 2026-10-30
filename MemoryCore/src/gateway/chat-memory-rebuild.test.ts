import { describe, expect, it, vi } from "vitest";

import { handleChatMemoryRebuild } from "./chat-memory-handlers.js";
import { buildProfileL2Key } from "../utils/pipeline-factory.js";

const auth = { serviceId: "default" } as never;

function deps(overrides: Record<string, unknown> = {}) {
  const enqueueL2 = vi.fn(async () => {});
  return {
    enqueueL2,
    deps: {
      getStore: () => ({ listContentSessionIds: async () => ["s1", "s2"] }),
      getStorage: () => undefined,
      getMetadataService: async () => ({
        resolveChatMemoryTargets: async () => [{ team_id: "t1", agent_id: "agt-a" }],
      }),
      enqueueL2,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ...overrides,
    },
  };
}

describe("/v3/chat-memory/rebuild", () => {
  it("queues one L2 run per session of the block, under that session's L2 key", async () => {
    const { deps: d, enqueueL2 } = deps();
    const res = await handleChatMemoryRebuild({ memory_id: "chat_memory-t1-agt-a" }, auth, "r1", d);

    expect(res.code).toBe(0);
    expect(res.data).toEqual({
      items: [
        { session_id: "s1", queued: true },
        { session_id: "s2", queued: true },
      ],
    });
    expect(enqueueL2).toHaveBeenCalledTimes(2);
    expect(enqueueL2).toHaveBeenCalledWith(
      "default",
      buildProfileL2Key({ teamId: "t1", agentId: "agt-a", sessionId: "s1" }),
      "t1",
      "agt-a",
    );
  });

  it("a dry run lists the sessions and queues nothing", async () => {
    const { deps: d, enqueueL2 } = deps();
    const res = await handleChatMemoryRebuild({ memory_id: "chat_memory-t1-agt-a", dry_run: true }, auth, "r2", d);

    expect(res.code).toBe(0);
    expect((res.data as { items: unknown[] }).items).toHaveLength(2);
    expect(enqueueL2).not.toHaveBeenCalled();
  });

  it("is unavailable without a pipeline", async () => {
    const { deps: d } = deps({ enqueueL2: undefined });
    const res = await handleChatMemoryRebuild({ memory_id: "chat_memory-t1-agt-a" }, auth, "r3", d);

    expect(res.code).toBe(503);
  });

  it("rejects a request without memory_id", async () => {
    const { deps: d } = deps();
    const res = await handleChatMemoryRebuild({}, auth, "r4", d);

    expect(res.code).toBe(400);
  });
});
