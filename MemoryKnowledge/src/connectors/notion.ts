/**
 * NotionConnector — reads pages from a Notion workspace through the public REST API.
 *
 * Scope: every page the integration has been shared with (Notion's `search` endpoint only
 * returns those). Pages inside databases are pages too, so they are covered.
 *
 * Uses plain `fetch` (no SDK dependency). Requests are throttled to Notion's ~3 req/s
 * average limit and 429 / 5xx responses are retried.
 */

import { createLogger } from "../logger.js";
import type { ConnectorDocRef, IKnowledgeConnector } from "./types.js";

const log = createLogger("notion-connector");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_RETRIES = 5;
const MAX_DEPTH = 6;

export interface NotionConnectorOptions {
  token: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between requests; Notion averages 3 req/s. */
  minIntervalMs?: number;
}

// ── minimal Notion API shapes (only the fields we read) ──

interface RichText {
  plain_text: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, { type: string; title?: RichText[] }>;
}

interface Paged<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export class NotionConnector implements IKnowledgeConnector {
  readonly id = "notion";

  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(opts: NotionConnectorOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? 350;
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  async listDocs(): Promise<ConnectorDocRef[]> {
    const docs: ConnectorDocRef[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      const page: Paged<NotionPage> = await this.request<Paged<NotionPage>>("POST", "/search", body);
      for (const p of page.results) {
        if (p.archived || p.in_trash) continue;
        docs.push({ id: p.id, title: pageTitle(p), editedAt: p.last_edited_time, url: p.url });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return docs;
  }

  async fetchDoc(ref: ConnectorDocRef): Promise<string> {
    const lines: string[] = [`# ${ref.title}`, ""];
    if (ref.url) lines.push(`Source: ${ref.url}`, "");
    lines.push(...(await this.renderChildren(ref.id, 0)));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  // ── block rendering ──

  private async listChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: Paged<NotionBlock> = await this.request<Paged<NotionBlock>>("GET", `/blocks/${blockId}/children${qs}`);
      blocks.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return blocks;
  }

  private async renderChildren(blockId: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    const blocks = await this.listChildren(blockId);
    const out: string[] = [];
    for (const block of blocks) {
      out.push(...(await this.renderBlock(block, depth)));
    }
    return out;
  }

  private async renderBlock(block: NotionBlock, depth: number): Promise<string[]> {
    const data = (block[block.type] ?? {}) as Record<string, unknown>;
    const text = richTextToMarkdown(data.rich_text as RichText[] | undefined);
    const indent = "  ".repeat(depth);
    // Child pages / databases are separate documents listed by search on their own.
    const skipChildren = block.type === "child_page" || block.type === "child_database" || block.type === "link_to_page";
    const children = block.has_children && !skipChildren ? await this.renderChildren(block.id, depth + 1) : [];

    switch (block.type) {
      case "paragraph":
        return text ? [text, "", ...children] : children;
      case "heading_1":
        return [`# ${text}`, "", ...children];
      case "heading_2":
        return [`## ${text}`, "", ...children];
      case "heading_3":
        return [`### ${text}`, "", ...children];
      case "bulleted_list_item":
      case "toggle":
        return [`${indent}- ${text}`, ...children];
      case "numbered_list_item":
        return [`${indent}1. ${text}`, ...children];
      case "to_do":
        return [`${indent}- [${data.checked ? "x" : " "}] ${text}`, ...children];
      case "quote":
        return [`> ${text}`, "", ...children];
      case "callout": {
        const icon = (data.icon as { emoji?: string } | null | undefined)?.emoji;
        return [`> ${icon ? `${icon} ` : ""}${text}`, "", ...children];
      }
      case "code": {
        const lang = typeof data.language === "string" && data.language !== "plain text" ? data.language : "";
        const code = ((data.rich_text as RichText[] | undefined) ?? []).map((r) => r.plain_text).join("");
        return [`\`\`\`${lang}`, code, "```", ""];
      }
      case "divider":
        return ["---", ""];
      case "equation":
        return [`$$${String(data.expression ?? "")}$$`, ""];
      case "child_page":
        return [`- (sub-page) ${String(data.title ?? "")}`];
      case "bookmark":
      case "embed":
      case "link_preview":
        return data.url ? [String(data.url), ""] : [];
      case "image":
      case "file":
      case "pdf":
      case "video":
      case "audio":
        return [mediaLine(block.type, data), ""];
      case "table":
        return [...renderTable(children, data.has_column_header === true), ""];
      case "table_row":
        // Rows are consumed by their parent `table` via renderTable().
        return [JSON.stringify(((data.cells as RichText[][] | undefined) ?? []).map((c) => richTextToMarkdown(c)))];
      default:
        // column_list / column / synced_block / unknown: keep any text and descend.
        return text ? [text, "", ...children] : children;
    }
  }

  // ── HTTP ──

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();

      const resp = await this.fetchFn(`${NOTION_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (resp.ok) return (await resp.json()) as T;

      if (resp.status === 401) throw new Error("Notion rejected the token (401): check KNOWLEDGE_CONNECTOR_NOTION_TOKEN");
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        throw new Error(`Notion API ${method} ${path} failed: HTTP ${resp.status}`);
      }
      const retryAfter = Number(resp.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      log.warn(`Notion ${resp.status} on ${path}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await this.sleep(delay);
    }
  }
}

// ── helpers (exported for tests) ──

export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") {
      const t = (prop.title ?? []).map((r) => r.plain_text).join("").trim();
      if (t) return t;
    }
  }
  return "Untitled";
}

export function richTextToMarkdown(parts: RichText[] | undefined): string {
  if (!parts) return "";
  return parts
    .map((r) => {
      let s = r.plain_text;
      if (!s) return "";
      const a = r.annotations ?? {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      if (r.href) s = `[${s}](${r.href})`;
      return s;
    })
    .join("");
}

function mediaLine(type: string, data: Record<string, unknown>): string {
  const caption = richTextToMarkdown(data.caption as RichText[] | undefined);
  const external = (data.external as { url?: string } | undefined)?.url;
  // Notion-hosted files use short-lived signed URLs, so only external URLs are kept.
  return external ? `[${caption || type}](${external})` : `[${type}${caption ? `: ${caption}` : ""}]`;
}

/** `rows` are the JSON-encoded cell arrays produced for each table_row child. */
function renderTable(rows: string[], hasHeader: boolean): string[] {
  const parsed = rows.map((r) => JSON.parse(r) as string[]);
  if (parsed.length === 0) return [];
  const width = Math.max(...parsed.map((r) => r.length));
  const fmt = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const head = hasHeader ? parsed[0]! : Array.from({ length: width }, () => "");
  const body = hasHeader ? parsed.slice(1) : parsed;
  return [fmt(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(fmt)];
}
