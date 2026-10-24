/**
 * ConnectorSyncService — diffs a connector's documents against what was last written into
 * the target wiki, applies the delta through WikiService, and triggers one ingest when
 * something changed.
 *
 * Incremental by construction: a manifest (doc id → editedAt + filename) is persisted after
 * every run, so an unchanged source costs one cheap listing and zero LLM tokens.
 */

import { createLogger } from "../logger.js";
import type { WikiService } from "../store/index.js";
import type { ConnectorsConfig } from "./config.js";
import type { IConnectorStore, Manifest, ConnectorState, SetEnabledOpts } from "./store.js";
import type { ConnectorDocRef, ConnectorSyncStats, IKnowledgeConnector } from "./types.js";

const log = createLogger("connector-sync");

/** The slice of WikiService this module needs (keeps tests free of a real wiki on disk). */
export type WikiPort = Pick<WikiService, "create" | "rawWrite" | "rawRm" | "ingest">;

const RM_BATCH = 50;
/** After a failed run, retry sooner than the normal interval (bounded by it). */
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ConnectorStatusView {
  id: string;
  /** Operator gate (KNOWLEDGE_CONNECTORS_ENABLED). When false nothing can run. */
  available: boolean;
  /** Credentials/target settings present. Never exposes the secrets themselves. */
  configured: boolean;
  enabled: boolean;
  running: boolean;
  interval_hours: number;
  wiki_name: string;
  team_id: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: ConnectorState["last_status"];
  last_error: string | null;
  last_stats: ConnectorSyncStats | null;
  tracked_docs: number;
}

export interface SyncServiceDeps {
  config: ConnectorsConfig;
  store: IConnectorStore;
  wikiService: WikiPort;
  connectors: IKnowledgeConnector[];
  /** Target wiki name per connector id. */
  wikiNames: Record<string, string>;
  now?: () => Date;
}

export type ActionResult = { ok: true } | { ok: false; reason: string };

export class ConnectorSyncService {
  private readonly config: ConnectorsConfig;
  private readonly store: IConnectorStore;
  private readonly wiki: WikiPort;
  private readonly connectors: Map<string, IKnowledgeConnector>;
  private readonly wikiNames: Record<string, string>;
  private readonly now: () => Date;
  private readonly running = new Set<string>();

  constructor(deps: SyncServiceDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.wiki = deps.wikiService;
    this.connectors = new Map(deps.connectors.map((c) => [c.id, c]));
    this.wikiNames = deps.wikiNames;
    this.now = deps.now ?? (() => new Date());
  }

  // ── read side ──

  getStatus(): ConnectorStatusView[] {
    return [...this.connectors.values()].map((c) => this.view(c));
  }

  private view(c: IKnowledgeConnector): ConnectorStatusView {
    const s = this.store.get(c.id);
    const { teamId } = this.resolveTarget(c.id);
    return {
      id: c.id,
      available: this.config.enabled,
      configured: this.isConfigured(c),
      enabled: s.enabled,
      running: this.running.has(c.id),
      interval_hours: this.config.intervalHours,
      wiki_name: this.wikiNames[c.id] ?? c.id,
      team_id: teamId || null,
      last_run_at: s.last_run_at,
      last_success_at: s.last_success_at,
      last_status: s.last_status,
      last_error: s.last_error,
      last_stats: s.last_stats,
      tracked_docs: Object.keys(s.manifest).length,
    };
  }

  private resolveTarget(connectorId: string): { serviceId: string; teamId: string } {
    const s = this.store.get(connectorId);
    return {
      serviceId: s.service_id || this.config.serviceId,
      teamId: s.team_id || this.config.teamId,
    };
  }

  private isConfigured(c: IKnowledgeConnector): boolean {
    const { serviceId, teamId } = this.resolveTarget(c.id);
    return c.isConfigured() && serviceId !== "" && teamId !== "";
  }

  // ── control side ──

  setEnabled(connectorId: string, enabled: boolean, opts?: SetEnabledOpts): ActionResult {
    if (!this.connectors.has(connectorId)) return { ok: false, reason: `unknown connector: ${connectorId}` };
    if (!this.config.enabled) {
      return { ok: false, reason: "connectors are disabled by the operator (KNOWLEDGE_CONNECTORS_ENABLED)" };
    }
    this.store.setEnabled(connectorId, enabled, opts);
    log.info(`connector ${connectorId} ${enabled ? "enabled" : "disabled"}`);
    return { ok: true };
  }

  /** Validate and start a run in the background (fire-and-forget). */
  trigger(connectorId: string, opts?: SetEnabledOpts): ActionResult {
    if (opts?.serviceId || opts?.teamId) {
      this.store.setTarget(connectorId, opts);
    }
    const reason = this.blockedReason(connectorId);
    if (reason) return { ok: false, reason };
    void this.runOnce(connectorId).catch((err) => log.error(`connector ${connectorId} run crashed: ${String(err)}`));
    return { ok: true };
  }

  private blockedReason(connectorId: string): string | null {
    const c = this.connectors.get(connectorId);
    if (!c) return `unknown connector: ${connectorId}`;
    if (!this.config.enabled) return "connectors are disabled by the operator (KNOWLEDGE_CONNECTORS_ENABLED)";
    if (!this.isConfigured(c)) return "connector is not configured (token / service id / team id missing)";
    if (!this.store.get(connectorId).enabled) return "connector is disabled — enable it first";
    if (this.running.has(connectorId)) return "a sync is already running";
    return null;
  }

  // ── scheduling helper ──

  /** True when a scheduled run should start now. */
  isDue(connectorId: string): boolean {
    if (this.config.intervalHours <= 0) return false;
    if (this.blockedReason(connectorId)) return false;
    const s = this.store.get(connectorId);
    const intervalMs = this.config.intervalHours * HOUR_MS;
    const ref = s.last_status === "error" ? s.last_run_at : s.last_success_at;
    if (!ref) return true;
    const wait = s.last_status === "error" ? Math.min(intervalMs, ERROR_RETRY_MS) : intervalMs;
    return this.now().getTime() - new Date(ref).getTime() >= wait;
  }

  listConnectorIds(): string[] {
    return [...this.connectors.keys()];
  }

  /** Startup recovery: a run left in `running` by a killed process can never finish. */
  recoverInterrupted(): void {
    for (const id of this.connectors.keys()) {
      if (this.store.get(id).last_status === "running" && !this.running.has(id)) {
        this.store.recordRun(id, { status: "error", error: "interrupted by restart" });
      }
    }
  }

  // ── the sync itself ──

  async runOnce(connectorId: string): Promise<void> {
    const reason = this.blockedReason(connectorId);
    if (reason) {
      log.info(`connector ${connectorId} skipped: ${reason}`);
      return;
    }
    const connector = this.connectors.get(connectorId)!;
    this.running.add(connectorId);
    this.store.markRunning(connectorId);
    try {
      await this.sync(connector);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`connector ${connectorId} failed: ${msg}`);
      this.store.recordRun(connectorId, { status: "error", error: msg });
    } finally {
      this.running.delete(connectorId);
    }
  }

  private async sync(connector: IKnowledgeConnector): Promise<void> {
    const { serviceId, teamId } = this.resolveTarget(connector.id);
    const prev = this.store.get(connector.id);
    const stats: ConnectorSyncStats = { added: 0, updated: 0, deleted: 0, failed: 0, ingestTriggered: false };

    const { row, existed } = this.wiki.create({
      service_id: serviceId,
      team_id: teamId,
      name: this.wikiNames[connector.id] ?? connector.id,
      source_type: connector.id,
    });
    const wikiId = row.wiki_id;
    // Wiki was (re)created empty → anything we think we wrote is gone.
    const manifest: Manifest = existed ? { ...prev.manifest } : {};

    const docs = await connector.listDocs();
    if (docs.length === 0 && Object.keys(manifest).length > 0) {
      throw new Error(
        `source returned no documents; refusing to delete ${Object.keys(manifest).length} tracked docs ` +
          "(was the integration un-shared or the token changed?)",
      );
    }

    const seen = new Set(docs.map((d) => d.id));
    const failedAbort = (outcome: string) =>
      new Error(`wiki ${wikiId} rejected the write (${outcome}); will retry on the next run`);

    // ── add / update ──
    for (const doc of docs) {
      const filename = filenameFor(connector.id, doc);
      const known = manifest[doc.id];
      if (known && known.editedAt === doc.editedAt && known.filename === filename) continue;

      let content: string;
      try {
        content = await connector.fetchDoc(doc);
      } catch (err) {
        stats.failed++;
        log.warn(`fetch failed for ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const outcome = this.wiki.rawWrite(serviceId, teamId, wikiId, filename, content);
      if (outcome === "processing") {
        this.persist(connector.id, manifest, stats, failedAbort("processing"));
        return;
      }
      if (outcome === null || typeof outcome === "string") {
        stats.failed++;
        log.warn(`rawWrite rejected ${doc.id} (${String(outcome)})`);
        continue;
      }
      if (known) stats.updated++;
      else stats.added++;
      // A renamed title changes the filename: drop the stale raw file.
      const stale = known && known.filename !== filename ? known.filename : null;
      manifest[doc.id] = { editedAt: doc.editedAt, filename };
      if (stale) await this.wiki.rawRm(serviceId, teamId, wikiId, [stale]);
    }

    // ── delete ──
    const gone = Object.keys(manifest).filter((id) => !seen.has(id));
    for (let i = 0; i < gone.length; i += RM_BATCH) {
      const batch = gone.slice(i, i + RM_BATCH);
      const outcome = await this.wiki.rawRm(serviceId, teamId, wikiId, batch.map((id) => manifest[id]!.filename));
      if (outcome === "processing") {
        this.persist(connector.id, manifest, stats, failedAbort("processing"));
        return;
      }
      if (outcome === null || typeof outcome === "string") {
        stats.failed += batch.length;
        log.warn(`rawRm rejected batch (${String(outcome)})`);
        continue;
      }
      for (const id of batch) delete manifest[id];
      stats.deleted += batch.length;
    }

    // ── ingest once if anything changed (or a previous run could not start it) ──
    const changed = stats.added + stats.updated + stats.deleted > 0;
    const carried = !!prev.last_stats && !prev.last_stats.ingestTriggered &&
      prev.last_stats.added + prev.last_stats.updated + prev.last_stats.deleted > 0;
    if (changed || carried) {
      const result = this.wiki.ingest(serviceId, teamId, wikiId);
      stats.ingestTriggered = result.kind === "ok";
      if (!stats.ingestTriggered) log.warn(`ingest not started (${result.kind}); will retry on the next run`);
    }

    this.persist(connector.id, manifest, stats, null);
    log.info(
      `connector ${connector.id} synced: +${stats.added} ~${stats.updated} -${stats.deleted} ` +
        `failed=${stats.failed} ingest=${stats.ingestTriggered}`,
    );
  }

  private persist(connectorId: string, manifest: Manifest, stats: ConnectorSyncStats, error: Error | null): void {
    this.store.recordRun(connectorId, {
      status: error ? "error" : "ok",
      error: error?.message ?? null,
      stats,
      manifest,
      success: error === null,
    });
  }
}

/** Stable, human-readable raw filename: `<source>-<title-slug>-<id8>.md`. */
export function filenameFor(connectorId: string, doc: ConnectorDocRef): string {
  const slug = doc.title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const short = doc.id.replace(/-/g, "").slice(0, 8);
  return `${connectorId}-${slug ? `${slug}-` : ""}${short}.md`;
}
