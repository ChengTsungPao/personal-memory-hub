/**
 * Connector admin routes — opt-in external-source sync (Notion, ...).
 *
 *   GET|POST /connectors/status       → per-connector state (read-only, no secrets)
 *   POST     /connectors/set-enabled  → { connector_id, enabled, team_id? }  (service key required)
 *   POST     /connectors/trigger      → { connector_id, team_id? }           (service key required)
 *
 * `status` is on the auth middleware's read-only list; the other two are not, so they need
 * `Authorization: Bearer <KNOWLEDGE_SERVICE_KEY>` whenever a service key is configured.
 * Tokens for external sources are env-only and are never accepted or returned here.
 *
 * Mounted under the API prefix by server.ts (→ /v3/connectors/...).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { wrapError, wrapOk } from "../api-helpers.js";
import type { ConnectorSyncService } from "../connectors/sync-service.js";

export interface ConnectorRouteDeps {
  service: ConnectorSyncService;
}

export function createConnectorRoutes({ service }: ConnectorRouteDeps) {
  const app = new Hono();

  const status = (c: Context) => c.json(wrapOk({ connectors: service.getStatus() }));
  // GET for curl, POST because MCP tools and MemoryPanel only issue POST.
  app.get("/connectors/status", status);
  app.post("/connectors/status", status);

  const readBody = async (c: Context): Promise<Record<string, unknown>> =>
    (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const extractTarget = (c: Context, body: Record<string, unknown>) => {
    const headerServiceId = c.req.header("x-tdai-service-id")?.trim();
    const bodyServiceId = typeof body.service_id === "string" ? body.service_id.trim() : "";
    const teamId = typeof body.team_id === "string" ? body.team_id.trim() : "";
    return {
      serviceId: headerServiceId || bodyServiceId || undefined,
      teamId: teamId || undefined,
    };
  };

  app.post("/connectors/set-enabled", async (c) => {
    const body = await readBody(c);
    const id = body.connector_id;
    if (typeof id !== "string" || !id) return c.json(wrapError(400, "connector_id is required"), 400);
    if (typeof body.enabled !== "boolean") return c.json(wrapError(400, "enabled (boolean) is required"), 400);
    if (!service.listConnectorIds().includes(id)) return c.json(wrapError(404, `unknown connector: ${id}`), 404);

    const result = service.setEnabled(id, body.enabled, extractTarget(c, body));
    if (!result.ok) return c.json(wrapError(409, result.reason), 409);
    return c.json(wrapOk({ connector_id: id, enabled: body.enabled }));
  });

  app.post("/connectors/trigger", async (c) => {
    const body = await readBody(c);
    const id = body.connector_id;
    if (typeof id !== "string" || !id) return c.json(wrapError(400, "connector_id is required"), 400);
    if (!service.listConnectorIds().includes(id)) return c.json(wrapError(404, `unknown connector: ${id}`), 404);

    const result = service.trigger(id, extractTarget(c, body));
    if (!result.ok) return c.json(wrapError(409, result.reason), 409);
    return c.json(wrapOk({ connector_id: id, triggered: true }));
  });

  return app;
}
