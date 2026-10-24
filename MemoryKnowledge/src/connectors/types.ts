/**
 * Knowledge connectors — opt-in, periodic import of an external knowledge source
 * (Notion first) into a wiki's raw sources.
 *
 * A connector only knows how to *list* and *read* documents from its source. Diffing,
 * wiki writes, ingest and scheduling live in `ConnectorSyncService`, so adding another
 * source (Obsidian vault, Confluence, ...) means implementing this one interface.
 */

/** Cheap reference to a remote document — no body, so listing stays inexpensive. */
export interface ConnectorDocRef {
  /** Stable id in the source system (e.g. Notion page id). */
  id: string;
  title: string;
  /** Source-side last-modified timestamp (ISO 8601); used to detect changes. */
  editedAt: string;
  /** Link back to the document in the source, when the source provides one. */
  url?: string;
}

export interface IKnowledgeConnector {
  /** Stable connector id, e.g. "notion". Also the primary key of its persisted state. */
  readonly id: string;
  /** True when credentials/settings needed to talk to the source are present. */
  isConfigured(): boolean;
  /** Every document currently visible in the source (id + title + editedAt only). */
  listDocs(): Promise<ConnectorDocRef[]>;
  /** Full document body rendered as Markdown. */
  fetchDoc(ref: ConnectorDocRef): Promise<string>;
}

export interface ConnectorSyncStats {
  added: number;
  updated: number;
  deleted: number;
  /** Docs whose write failed this run; they are retried on the next run. */
  failed: number;
  /** True when an ingest was triggered because something changed. */
  ingestTriggered: boolean;
}

export type ConnectorRunStatus = "running" | "ok" | "error";
