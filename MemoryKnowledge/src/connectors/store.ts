/**
 * ConnectorStore — persisted per-connector state (runtime switch, last run, manifest).
 *
 * Decoupled from IKnowledgeStore, same shape as `createLlmBindingStore`: one small table
 * keyed by connector id. A connector with no row is simply "disabled, never run".
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledgeConnector } from "../db/schema.js";
import type { ConnectorRunStatus, ConnectorSyncStats } from "./types.js";

/** What was last written into the wiki for one remote document. */
export interface ManifestEntry {
  editedAt: string;
  /** Raw-source filename inside the wiki. */
  filename: string;
}

export type Manifest = Record<string, ManifestEntry>;

export interface ConnectorState {
  connector_id: string;
  enabled: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: ConnectorRunStatus | null;
  last_error: string | null;
  last_stats: ConnectorSyncStats | null;
  manifest: Manifest;
  updated_at: string | null;
}

export interface RunResult {
  status: ConnectorRunStatus;
  error?: string | null;
  stats?: ConnectorSyncStats | null;
  /** When provided, replaces the stored manifest. */
  manifest?: Manifest;
  /** Set true on a fully successful run; bumps last_success_at. */
  success?: boolean;
}

export interface IConnectorStore {
  get(connectorId: string): ConnectorState;
  setEnabled(connectorId: string, enabled: boolean): ConnectorState;
  /** Mark a run as started (status=running). */
  markRunning(connectorId: string): void;
  /** Record the outcome of a run. */
  recordRun(connectorId: string, result: RunResult): ConnectorState;
}

function emptyState(connectorId: string): ConnectorState {
  return {
    connector_id: connectorId,
    enabled: false,
    last_run_at: null,
    last_success_at: null,
    last_status: null,
    last_error: null,
    last_stats: null,
    manifest: {},
    updated_at: null,
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type Row = typeof knowledgeConnector.$inferSelect;

function toState(row: Row): ConnectorState {
  return {
    connector_id: row.connectorId,
    enabled: row.enabled === 1,
    last_run_at: row.lastRunAt,
    last_success_at: row.lastSuccessAt,
    last_status: (row.lastStatus as ConnectorRunStatus | null) ?? null,
    last_error: row.lastError,
    last_stats: parseJson<ConnectorSyncStats | null>(row.lastStatsJson, null),
    manifest: parseJson<Manifest>(row.manifestJson, {}),
    updated_at: row.updatedAt,
  };
}

export function createConnectorStore(db: Db): IConnectorStore {
  const read = (connectorId: string): Row | undefined =>
    db.select().from(knowledgeConnector).where(eq(knowledgeConnector.connectorId, connectorId)).all()[0];

  /** Insert-if-missing, then patch. Keeps every writer a single code path. */
  const patch = (connectorId: string, values: Partial<Omit<Row, "connectorId" | "updatedAt">>): ConnectorState => {
    const now = new Date().toISOString();
    if (!read(connectorId)) {
      db.insert(knowledgeConnector).values({ connectorId, updatedAt: now }).run();
    }
    db.update(knowledgeConnector)
      .set({ ...values, updatedAt: now })
      .where(eq(knowledgeConnector.connectorId, connectorId))
      .run();
    return toState(read(connectorId)!);
  };

  return {
    get(connectorId) {
      const row = read(connectorId);
      return row ? toState(row) : emptyState(connectorId);
    },

    setEnabled(connectorId, enabled) {
      return patch(connectorId, { enabled: enabled ? 1 : 0 });
    },

    markRunning(connectorId) {
      patch(connectorId, { lastStatus: "running", lastRunAt: new Date().toISOString() });
    },

    recordRun(connectorId, result) {
      const now = new Date().toISOString();
      return patch(connectorId, {
        lastStatus: result.status,
        lastError: result.error ?? null,
        lastStatsJson: result.stats ? JSON.stringify(result.stats) : null,
        ...(result.manifest !== undefined ? { manifestJson: JSON.stringify(result.manifest) } : {}),
        ...(result.success ? { lastSuccessAt: now } : {}),
      });
    },
  };
}
