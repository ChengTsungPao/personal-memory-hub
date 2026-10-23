/**
 * Connector settings, resolved from env (same pattern as `resolveAutoSyncConfig`).
 *
 * Two layers of opt-in:
 *   1. Operator gate — KNOWLEDGE_CONNECTORS_ENABLED (default false). When off, the
 *      scheduler never starts, no connector code runs and no outbound request is made.
 *   2. Per-connector runtime switch — persisted in SQLite (default off), flipped through
 *      `POST /connectors/set-enabled` (service-key protected) or the MCP tool.
 *
 * Secrets (tokens) are env-only on purpose: they must never travel through the MCP/API
 * surface, where they would be echoed into agent transcripts.
 */

export interface NotionConnectorConfig {
  /** Notion internal-integration token (ntn_...). Env-only. */
  token: string;
  /** Wiki (by name) the Notion pages are written into; created on first sync. */
  wikiName: string;
}

export interface ConnectorsConfig {
  /** Operator gate; false = the whole feature is inert. */
  enabled: boolean;
  /** Hours between scheduled syncs. 0 = scheduler off, manual trigger only. */
  intervalHours: number;
  /** Tenant the target wikis live under. */
  serviceId: string;
  teamId: string;
  notion: NotionConnectorConfig;
}

export const DEFAULT_INTERVAL_HOURS = 168; // weekly
const MAX_INTERVAL_HOURS = 24 * 90;

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseIntervalHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_HOURS;
  return Math.min(n, MAX_INTERVAL_HOURS);
}

export function resolveConnectorsConfig(
  env: Record<string, string | undefined> = process.env,
): ConnectorsConfig {
  return {
    enabled: parseBoolean(env.KNOWLEDGE_CONNECTORS_ENABLED, false),
    intervalHours: parseIntervalHours(env.KNOWLEDGE_CONNECTORS_INTERVAL_HOURS),
    serviceId: (env.KNOWLEDGE_CONNECTORS_SERVICE_ID ?? "").trim(),
    teamId: (env.KNOWLEDGE_CONNECTORS_TEAM_ID ?? "").trim(),
    notion: {
      token: (env.KNOWLEDGE_CONNECTOR_NOTION_TOKEN ?? "").trim(),
      wikiName: (env.KNOWLEDGE_CONNECTOR_NOTION_WIKI_NAME ?? "").trim() || "Notion",
    },
  };
}
