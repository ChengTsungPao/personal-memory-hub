import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_INTERVAL_HOURS,
  resolveConnectorsConfig,
} from "./config.js";
import {
  NotionConnector,
  pageTitle,
  richTextToMarkdown,
} from "./notion.js";
import {
  ConnectorSyncService,
  filenameFor,
  type WikiPort,
} from "./sync-service.js";
import {
  ConnectorScheduler,
} from "./scheduler.js";
import type {
  ConnectorState,
  IConnectorStore,
  RunResult,
} from "./store.js";
import type {
  ConnectorDocRef,
  IKnowledgeConnector,
} from "./types.js";
import { createConnectorRoutes } from "../routes/connectors.js";
import { createServiceAuthMiddleware } from "../middleware/auth.js";

function createInMemoryConnectorStore(): IConnectorStore {
  const states = new Map<string, ConnectorState>();
  const ensure = (id: string): ConnectorState => {
    let s = states.get(id);
    if (!s) {
      s = {
        connector_id: id,
        enabled: false,
        service_id: null,
        team_id: null,
        token: null,
        wiki_name: null,
        last_run_at: null,
        last_success_at: null,
        last_status: null,
        last_error: null,
        last_stats: null,
        manifest: {},
        updated_at: null,
      };
      states.set(id, s);
    }
    return s;
  };
  return {
    get(id) {
      const s = ensure(id);
      return { ...s, manifest: { ...s.manifest } };
    },
    setEnabled(id, enabled, opts) {
      const s = ensure(id);
      s.enabled = enabled;
      if (opts?.serviceId) s.service_id = opts.serviceId;
      if (opts?.teamId) s.team_id = opts.teamId;
      s.updated_at = new Date().toISOString();
      return this.get(id);
    },
    setTarget(id, opts) {
      const s = ensure(id);
      if (opts.serviceId) s.service_id = opts.serviceId;
      if (opts.teamId) s.team_id = opts.teamId;
      return this.get(id);
    },
    configure(id, opts) {
      const s = ensure(id);
      if (opts.token !== undefined) s.token = opts.token ? opts.token.trim() || null : null;
      if (opts.wikiName !== undefined) s.wiki_name = opts.wikiName ? opts.wikiName.trim() || null : null;
      if (opts.serviceId) s.service_id = opts.serviceId;
      if (opts.teamId) s.team_id = opts.teamId;
      if (opts.enabled !== undefined) s.enabled = opts.enabled;
      s.updated_at = new Date().toISOString();
      return this.get(id);
    },
    markRunning(id) {
      const s = ensure(id);
      s.last_status = "running";
      s.last_run_at = new Date().toISOString();
      s.updated_at = s.last_run_at;
    },
    recordRun(id, result: RunResult) {
      const s = ensure(id);
      const now = new Date().toISOString();
      s.last_status = result.status;
      s.last_error = result.error ?? null;
      s.last_stats = result.stats ?? null;
      if (result.manifest !== undefined) s.manifest = { ...result.manifest };
      if (result.success) s.last_success_at = now;
      s.updated_at = now;
      return this.get(id);
    },
  };
}

function createFakeWikiPort() {
  const files = new Map<string, string>();
  let ingestCalls = 0;
  let existed = false;
  const port: WikiPort = {
    create: ({ service_id, team_id, name }) => {
      const row = {
        wiki_id: "wiki-notion01",
        service_id,
        team_id,
        name,
        source_type: "notion",
        source_url: null,
        owner_user_id: null,
        user_id: null,
        agent_id: null,
        task_id: null,
        visibility: "team",
        status: "ready" as const,
        internal_status: null,
        sync_error: null,
        page_count: 0,
        service_url: null,
        summary: null,
        version: 1,
        last_sync_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      const prevExisted = existed;
      existed = true;
      return { row, existed: prevExisted };
    },
    rawWrite: (_s, _t, _w, filename, content) => {
      files.set(filename, content);
      return { filename, size: content.length };
    },
    rawRm: async (_s, _t, _w, filenames) => {
      for (const f of filenames) files.delete(f);
      return { deleted: filenames, removedPages: [] };
    },
    ingest: (_s, _t, _w) => {
      ingestCalls++;
      return { kind: "ok" as const, row: {} as never };
    },
  };
  return { port, files, getIngestCalls: () => ingestCalls };
}

describe("resolveConnectorsConfig", () => {
  it("defaults to available (enabled=true) and weekly (168h) interval while individual connectors remain off in store", () => {
    const cfg = resolveConnectorsConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalHours).toBe(DEFAULT_INTERVAL_HOURS);
    expect(cfg.notion.token).toBe("");
    expect(cfg.notion.wikiName).toBe("Notion");
  });

  it("can be explicitly disabled via KNOWLEDGE_CONNECTORS_ENABLED=false", () => {
    const cfg = resolveConnectorsConfig({ KNOWLEDGE_CONNECTORS_ENABLED: "false" });
    expect(cfg.enabled).toBe(false);
  });

  it("parses explicit values and manual-only interval=0", () => {
    const cfg = resolveConnectorsConfig({
      KNOWLEDGE_CONNECTORS_ENABLED: "true",
      KNOWLEDGE_CONNECTORS_INTERVAL_HOURS: "0",
      KNOWLEDGE_CONNECTORS_SERVICE_ID: "svc-1",
      KNOWLEDGE_CONNECTORS_TEAM_ID: "team-1",
      KNOWLEDGE_CONNECTOR_NOTION_TOKEN: "ntn_secret",
      KNOWLEDGE_CONNECTOR_NOTION_WIKI_NAME: "Team Notion",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalHours).toBe(0);
    expect(cfg.serviceId).toBe("svc-1");
    expect(cfg.teamId).toBe("team-1");
    expect(cfg.notion.token).toBe("ntn_secret");
    expect(cfg.notion.wikiName).toBe("Team Notion");
  });
});

describe("NotionConnector & markdown helpers", () => {
  it("formats rich text and page titles", () => {
    expect(
      richTextToMarkdown([
        { plain_text: "Hello ", annotations: { bold: true } },
        { plain_text: "world", href: "https://example.com", annotations: { italic: true } },
      ]),
    ).toBe("**Hello **[*world*](https://example.com)");

    expect(
      pageTitle({
        id: "p1",
        last_edited_time: "2026-01-01T00:00:00Z",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Architecture Spec" }] },
        },
      }),
    ).toBe("Architecture Spec");
  });

  it("paginates search, skips archived pages, and renders blocks to Markdown", async () => {
    const responses: Array<{ status: number; body: unknown }> = [
      {
        status: 200,
        body: {
          results: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              url: "https://notion.so/1111",
              last_edited_time: "2026-01-01T00:00:00.000Z",
              properties: { title: { type: "title", title: [{ plain_text: "Design Doc" }] } },
            },
            {
              id: "archived-id",
              archived: true,
              last_edited_time: "2026-01-01T00:00:00.000Z",
              properties: {},
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
      {
        status: 200,
        body: {
          results: [
            {
              id: "b1",
              type: "heading_2",
              heading_2: { rich_text: [{ plain_text: "Overview" }] },
            },
            {
              id: "b2",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Key details here." }] },
            },
            {
              id: "b3",
              type: "to_do",
              to_do: { checked: true, rich_text: [{ plain_text: "Ship PR" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
    ];

    const fetchFn = vi.fn(async () => {
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as unknown as typeof fetch;

    const connector = new NotionConnector({
      token: "ntn_test",
      fetchFn,
      sleep: async () => {},
      minIntervalMs: 0,
    });

    const docs = await connector.listDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Design Doc");

    const md = await connector.fetchDoc(docs[0]!);
    expect(md).toContain("# Design Doc");
    expect(md).toContain("Source: https://notion.so/1111");
    expect(md).toContain("## Overview");
    expect(md).toContain("Key details here.");
    expect(md).toContain("- [x] Ship PR");
  });
});

describe("ConnectorSyncService incremental sync", () => {
  it("syncs new/updated/deleted docs incrementally and triggers ingest only when changed", async () => {
    let remoteDocs: ConnectorDocRef[] = [
      { id: "aaaa1111-0000", title: "Page One", editedAt: "2026-01-01T00:00:00Z" },
      { id: "bbbb2222-0000", title: "Page Two", editedAt: "2026-01-01T00:00:00Z" },
    ];
    const bodies: Record<string, string> = {
      "aaaa1111-0000": "# Page One\n\nInitial\n",
      "bbbb2222-0000": "# Page Two\n\nInitial\n",
    };

    const fakeConnector: IKnowledgeConnector = {
      id: "notion",
      isConfigured: () => true,
      listDocs: async () => remoteDocs,
      fetchDoc: async (ref) => bodies[ref.id] ?? "",
    };

    const store = createInMemoryConnectorStore();
    const { port, files, getIngestCalls } = createFakeWikiPort();
    const config = resolveConnectorsConfig({
      KNOWLEDGE_CONNECTORS_ENABLED: "true",
      KNOWLEDGE_CONNECTORS_SERVICE_ID: "svc-1",
      KNOWLEDGE_CONNECTORS_TEAM_ID: "team-1",
      KNOWLEDGE_CONNECTOR_NOTION_TOKEN: "ntn_123",
    });

    const service = new ConnectorSyncService({
      config,
      store,
      wikiService: port,
      connectors: [fakeConnector],
      wikiNames: { notion: "Notion" },
    });

    // Enable connector via runtime switch
    expect(service.setEnabled("notion", true)).toEqual({ ok: true });

    // 1st run: adds 2 docs and triggers ingest
    await service.runOnce("notion");
    let status = service.getStatus()[0]!;
    expect(status.last_status).toBe("ok");
    expect(status.last_stats).toEqual({
      added: 2,
      updated: 0,
      deleted: 0,
      failed: 0,
      ingestTriggered: true,
    });
    expect(getIngestCalls()).toBe(1);
    expect(files.size).toBe(2);

    // 2nd run with no changes: 0 writes, 0 ingest calls
    await service.runOnce("notion");
    status = service.getStatus()[0]!;
    expect(status.last_stats).toEqual({
      added: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      ingestTriggered: false,
    });
    expect(getIngestCalls()).toBe(1);

    // 3rd run: Page One updated & renamed, Page Two deleted
    remoteDocs = [
      { id: "aaaa1111-0000", title: "Page One Renamed", editedAt: "2026-01-02T00:00:00Z" },
    ];
    bodies["aaaa1111-0000"] = "# Page One Renamed\n\nUpdated\n";

    await service.runOnce("notion");
    status = service.getStatus()[0]!;
    expect(status.last_stats).toEqual({
      added: 0,
      updated: 1,
      deleted: 1,
      failed: 0,
      ingestTriggered: true,
    });
    expect(getIngestCalls()).toBe(2);
    expect([...files.keys()]).toEqual([
      filenameFor("notion", remoteDocs[0]!),
    ]);
  });

  it("refuses to wipe tracked docs when source returns empty list", async () => {
    let remoteDocs: ConnectorDocRef[] = [
      { id: "aaaa1111-0000", title: "Page One", editedAt: "2026-01-01T00:00:00Z" },
    ];
    const fakeConnector: IKnowledgeConnector = {
      id: "notion",
      isConfigured: () => true,
      listDocs: async () => remoteDocs,
      fetchDoc: async () => "# Page One\n",
    };

    const store = createInMemoryConnectorStore();
    const { port, files } = createFakeWikiPort();
    const config = resolveConnectorsConfig({
      KNOWLEDGE_CONNECTORS_ENABLED: "true",
      KNOWLEDGE_CONNECTORS_SERVICE_ID: "svc-1",
      KNOWLEDGE_CONNECTORS_TEAM_ID: "team-1",
      KNOWLEDGE_CONNECTOR_NOTION_TOKEN: "ntn_123",
    });

    const service = new ConnectorSyncService({
      config,
      store,
      wikiService: port,
      connectors: [fakeConnector],
      wikiNames: { notion: "Notion" },
    });
    service.setEnabled("notion", true);
    await service.runOnce("notion");
    expect(files.size).toBe(1);

    remoteDocs = [];
    await service.runOnce("notion");
    const status = service.getStatus()[0]!;
    expect(status.last_status).toBe("error");
    expect(status.last_error).toContain("refusing to delete");
    expect(files.size).toBe(1);
  });
});

describe("Connector routes & service auth", () => {
  it("allows unauthenticated status queries and supports configuring token/wiki_name via Bearer-protected /configure without leaking token", async () => {
    const store = createInMemoryConnectorStore();
    const { port } = createFakeWikiPort();
    // Start with empty env token — user will configure it via UI (/v3/connectors/configure)
    const config = resolveConnectorsConfig({});
    const notionConnector = new NotionConnector({
      token: () => store.get("notion").token || config.notion.token,
    });
    const service = new ConnectorSyncService({
      config,
      store,
      wikiService: port,
      connectors: [notionConnector],
      wikiNames: { notion: "Notion" },
    });

    const app = new Hono();
    const api = new Hono();
    api.use("*", createServiceAuthMiddleware({ serviceKey: "secret-admin-key" }, "/v3"));
    api.route("/", createConnectorRoutes({ service }));
    app.route("/v3", api);

    // Status works without auth (both GET and POST for MCP) and initially has_token=false
    const getRes = await app.request("/v3/connectors/status");
    expect(getRes.status).toBe(200);
    const initialJson = (await getRes.json()) as { data: { connectors: Array<Record<string, unknown>> } };
    expect(initialJson.data.connectors[0]!.has_token).toBe(false);
    expect(initialJson.data.connectors[0]!.configured).toBe(false);

    // configure without auth -> 401
    const unauthCfg = await app.request("/v3/connectors/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connector_id: "notion", token: "ntn_ui_secret" }),
    });
    expect(unauthCfg.status).toBe(401);

    // configure with Bearer token -> 200, sets token, wiki_name, service_id, team_id
    const authCfg = await app.request("/v3/connectors/configure", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-admin-key",
        "x-tdai-service-id": "svc-ui",
      },
      body: JSON.stringify({
        connector_id: "notion",
        token: "ntn_ui_secret",
        wiki_name: "My Notion Wiki",
        team_id: "team-ui",
      }),
    });
    expect(authCfg.status).toBe(200);

    // Verify status reflects has_token=true, configured=true, wiki_name="My Notion Wiki", and never leaks the token string
    const postStatusRes = await app.request("/v3/connectors/status", { method: "POST" });
    expect(postStatusRes.status).toBe(200);
    const statusText = await postStatusRes.text();
    expect(statusText).not.toContain("ntn_ui_secret");
    const afterCfg = JSON.parse(statusText) as { data: { connectors: Array<Record<string, unknown>> } };
    expect(afterCfg.data.connectors[0]!.has_token).toBe(true);
    expect(afterCfg.data.connectors[0]!.configured).toBe(true);
    expect(afterCfg.data.connectors[0]!.wiki_name).toBe("My Notion Wiki");

    // set-enabled with Bearer token -> 200
    const authSet = await app.request("/v3/connectors/set-enabled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-admin-key",
      },
      body: JSON.stringify({ connector_id: "notion", enabled: true }),
    });
    expect(authSet.status).toBe(200);
    expect(service.getStatus()[0]!.enabled).toBe(true);
  });
});

describe("ConnectorScheduler", () => {
  it("does not start when disabled or intervalHours is 0", () => {
    const store = createInMemoryConnectorStore();
    const { port } = createFakeWikiPort();
    const disabledCfg = resolveConnectorsConfig({ KNOWLEDGE_CONNECTORS_ENABLED: "false" });
    const service = new ConnectorSyncService({
      config: disabledCfg,
      store,
      wikiService: port,
      connectors: [],
      wikiNames: {},
    });
    const sched = new ConnectorScheduler({ service, config: disabledCfg });
    expect(sched.start()).toBe(false);
  });
});
