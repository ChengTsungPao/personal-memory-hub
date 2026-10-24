/**
 * Connector settings, resolved from env (same pattern as `resolveAutoSyncConfig`).
 *
 * Opt-in by default:
 *   - Each connector's runtime switch (`enabled`) in SQLite defaults to `false`, so no
 *     connector code runs and no outbound request is made until the user enables it in
 *     MemoryPanel (or via MCP / API).
 *   - Operators can hard-disable the entire connector subsystem via
 *     `KNOWLEDGE_CONNECTORS_ENABLED=false`.
 *
 * Credentials (tokens) can be configured either via `.env` (`KNOWLEDGE_CONNECTOR_NOTION_TOKEN`)
 * or saved through the MemoryPanel UI (`POST /connectors/configure`, stored in SQLite).
 * Tokens are never returned by `/connectors/status` and never exposed to MCP tools.
 */

export interface NotionConnectorConfig {
  /** Fallback Notion internal-integration token (ntn_...) from env. */
  token: string;
  /** Default Wiki (by name) the Notion pages are written into; created on first sync. */
  wikiName: string;
}

export interface ConnectorsConfig {
  /** Operator gate; false = the whole feature is inert. Default true so UI setup works out of the box. */
  enabled: boolean;
  /** Hours between scheduled syncs. 0 = scheduler off, manual trigger only. */
  intervalHours: number;
  /** Default tenant the target wikis live under (overridable per connector via UI/API). */
  serviceId: string;
  teamId: string;
  notion: NotionConnectorConfig;
}

export const DEFAULT_INTERVAL_HOURS = 168; // weekly
const MAX_INTERVAL_HOURS = 24 * 90;

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
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
    enabled: parseBoolean(env.KNOWLEDGE_CONNECTORS_ENABLED, true),
    intervalHours: parseIntervalHours(env.KNOWLEDGE_CONNECTORS_INTERVAL_HOURS),
    serviceId: (env.KNOWLEDGE_CONNECTORS_SERVICE_ID ?? "").trim(),
    teamId: (env.KNOWLEDGE_CONNECTORS_TEAM_ID ?? "").trim(),
    notion: {
      token: (env.KNOWLEDGE_CONNECTOR_NOTION_TOKEN ?? "").trim(),
      wikiName: (env.KNOWLEDGE_CONNECTOR_NOTION_WIKI_NAME ?? "").trim() || "Notion",
    },
  };
}
