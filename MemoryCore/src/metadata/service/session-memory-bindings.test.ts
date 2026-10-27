import { beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import type { AgentEntity } from "../types.js";

// Session memory blocks: each session has a hidden session agent; its chat_memory is bound to the
// repo agents (or New-chat) the session belongs to.
describe("session memory block bindings", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let userId: string;
  let teamId: string;
  let cleared: string[];

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store);
    cleared = [];
    svc.setChatMemoryContentCleaner(async ({ agentId }) => {
      cleared.push(agentId);
    });
    userId = store.createUser({ username: "u", auth_provider: "local", external_id: "u" }).user_id;
    teamId = store.createTeam({ name: "t", owner_user_id: userId }).team_id;
  });

  const agent = (name: string, kind?: string) =>
    svc.createAgent({
      team_id: teamId,
      owner_user_id: userId,
      name,
      ...(kind ? { metadata_json: JSON.stringify({ kind }) } : {}),
    });
  const block = (a: AgentEntity) => buildChatMemoryAssetId(teamId, a.agent_id);
  const bind = (to: AgentEntity, owner: AgentEntity) =>
    svc.addAgentFixedAsset(to.agent_id, { asset_id: block(owner), asset_type: "chat_memory", created_by: userId });
  const boundTo = async (owner: AgentEntity) =>
    (await svc.listAssetBindings(block(owner))).map((b) => b.agent_id).sort();
  const status = async (a: AgentEntity) => (await svc.getAgentById(a.agent_id))?.status;

  it("removes one binding and keeps the others", async () => {
    const a = await agent("repo-a");
    const b = await agent("repo-b");
    const s = await agent("s1", "session");
    await bind(a, s);
    await bind(b, s);

    await svc.removeAgentFixedAsset(a.agent_id, block(s));
    await svc.removeAgentFixedAsset(a.agent_id, block(s)); // idempotent

    expect(await boundTo(s)).toEqual([b.agent_id, s.agent_id].sort());
  });

  it("deleting a repo agent unbinds its session blocks and deletes the ones nothing else binds", async () => {
    const a = await agent("repo-a");
    const b = await agent("repo-b");
    const onlyA = await agent("s1", "session");
    const aAndB = await agent("s2", "session");
    await bind(a, onlyA);
    await bind(a, aAndB);
    await bind(b, aAndB);

    await svc.archiveAgent(a.agent_id);

    expect(await status(onlyA)).toBe("inactive");
    expect(await svc.getAssetById(block(onlyA))).toBeNull();
    expect(cleared).toContain(onlyA.agent_id);

    expect(await status(aAndB)).toBe("active");
    expect(await boundTo(aAndB)).toEqual([aAndB.agent_id, b.agent_id].sort());
    expect(cleared).not.toContain(aAndB.agent_id);
  });

  it("leaves an ordinary agent's memory alone when an agent it was shared with is deleted", async () => {
    const a = await agent("repo-a");
    const plain = await agent("plain");
    await bind(a, plain);

    await svc.archiveAgent(a.agent_id);

    expect(await status(plain)).toBe("active");
    expect(await boundTo(plain)).toEqual([plain.agent_id]);
  });

  it("deleting a session block removes it from every agent", async () => {
    const a = await agent("repo-a");
    const b = await agent("repo-b");
    const s = await agent("s1", "session");
    await bind(a, s);
    await bind(b, s);

    await svc.archiveAgent(s.agent_id);

    expect(await svc.listAssetBindings(block(s))).toEqual([]);
    expect(cleared).toEqual([s.agent_id]);
    expect(await status(a)).toBe("active");
  });
});
