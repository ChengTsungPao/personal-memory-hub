import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerChatMemoryRoutes } from '../../src/panel/http/routes/chat-memory.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

function createTestApp() {
  const agents = new Map<string, {
    agent_id: string;
    team_id: string;
    owner_user_id: string;
    name: string;
    metadata_json: string;
  }>([
    [
      'agt-repo-1',
      {
        agent_id: 'agt-repo-1',
        team_id: 'team-1',
        owner_user_id: 'usr-1',
        name: 'my-repo',
        metadata_json: JSON.stringify({ kind: 'repo', root_commit: 'abc1234' }),
      },
    ],
  ]);

  const fixedAssets = [
    {
      asset_id: 'chat_memory-team-1-agt-s1',
      asset_type: 'chat_memory',
      name: 'Session 1',
      status: 'active',
      visibility: 'private',
      created_at: '2026-10-30T00:00:00Z',
    },
    {
      asset_id: 'chat_memory-team-1-agt-s2',
      asset_type: 'chat_memory',
      name: 'Session 2',
      status: 'active',
      visibility: 'private',
      created_at: '2026-10-30T01:00:00Z',
    },
    {
      asset_id: 'chat_memory-team-1-agt-s3',
      asset_type: 'chat_memory',
      name: 'Session 3',
      status: 'active',
      visibility: 'private',
      created_at: '2026-10-30T02:00:00Z',
    },
  ];

  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: 'http://memory-core:8420',
        api_key: '',
      }),
    },
    metaKernel: {
      invoke: async (action: string, body: Record<string, any>) => {
        if (action === 'auth/verify') {
          return { code: 0, message: 'OK', request_id: 'req-1', data: { valid: true, user: { user_id: 'usr-1' } } };
        }
        if (action === 'agent/get') {
          const a = agents.get(body.agent_id);
          return a
            ? { code: 0, message: 'OK', request_id: 'req-1', data: a }
            : { code: 404, message: 'NOT_FOUND', request_id: 'req-1', data: null };
        }
        if (action === 'agent/update') {
          const a = agents.get(body.agent_id);
          if (!a) return { code: 404, message: 'NOT_FOUND', request_id: 'req-1', data: null };
          if (typeof body.metadata_json === 'string') a.metadata_json = body.metadata_json;
          if (typeof body.name === 'string') a.name = body.name;
          return { code: 0, message: 'OK', request_id: 'req-1', data: a };
        }
        if (action === 'agent-fixed-asset/list-with-detail') {
          return {
            code: 0,
            message: 'OK',
            request_id: 'req-1',
            data: { items: fixedAssets, total: fixedAssets.length, limit: 100, offset: 0 },
          };
        }
        if (action === 'asset/get') {
          const hit = fixedAssets.find((x) => x.asset_id === body.asset_id);
          return {
            code: 0,
            message: 'OK',
            request_id: 'req-1',
            data: hit ? { ...hit, owner_user_id: 'usr-1', updated_at: hit.created_at } : null,
          };
        }
        return { code: 404, message: `unhandled: ${action}`, request_id: 'req-1', data: null };
      },
    },
  } as unknown as PanelDeps;

  const app = new Hono();
  registerChatMemoryRoutes(app, deps);
  return { app, agents };
}

describe('chat-memory block ordering in metadata', () => {
  const headers = {
    'Content-Type': 'application/json',
    'X-Tdai-Service-Id': 'default',
    'X-Tdai-User-Key': 'sk-mem-test',
  };

  it('persists block_order in agent metadata and applies it on agent-fixed', async () => {
    const { app, agents } = createTestApp();

    // 1. Before reorder: has_custom_order is false, default order s1, s2, s3
    const res1 = await app.request('/chat-memory/agent-fixed', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent_id: 'agt-repo-1' }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    expect(body1.data.has_custom_order).toBe(false);
    expect(body1.data.items.map((x: any) => x.id)).toEqual([
      'chat_memory-team-1-agt-s1',
      'chat_memory-team-1-agt-s2',
      'chat_memory-team-1-agt-s3',
    ]);

    // 2. Save custom order: s3, s1 (s2 left out to test new/unplaced blocks coming first)
    const resReorder = await app.request('/chat-memory/reorder-blocks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agent_id: 'agt-repo-1',
        block_ids: ['chat_memory-team-1-agt-s3', 'chat_memory-team-1-agt-s1'],
      }),
    });
    expect(resReorder.status).toBe(200);
    const meta = JSON.parse(agents.get('agt-repo-1')!.metadata_json);
    expect(meta.kind).toBe('repo');
    expect(meta.root_commit).toBe('abc1234');
    expect(meta.block_order).toEqual(['chat_memory-team-1-agt-s3', 'chat_memory-team-1-agt-s1']);

    // 3. After reorder: unplaced s2 comes first, then s3, s1; has_custom_order is true
    const res2 = await app.request('/chat-memory/agent-fixed', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent_id: 'agt-repo-1' }),
    });
    const body2 = (await res2.json()) as any;
    expect(body2.data.has_custom_order).toBe(true);
    expect(body2.data.items.map((x: any) => x.id)).toEqual([
      'chat_memory-team-1-agt-s2',
      'chat_memory-team-1-agt-s3',
      'chat_memory-team-1-agt-s1',
    ]);
  });
});
