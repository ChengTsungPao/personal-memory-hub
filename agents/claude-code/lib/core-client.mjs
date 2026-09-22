/**
 * Minimal MemoryCore v3 data-plane client.
 *
 * Zero dependencies — Node's built-in fetch and AbortController only, so the
 * hooks can be dropped onto a machine and run with no install step.
 *
 * Auth layering (see v3-api-memorycore-doc.md §1.4):
 *   Layer 1  `Authorization: Bearer <kernel token>`  — gateway gate, optional
 *            when the gateway has no apiKey configured
 *   Data plane additionally needs `x-tdai-service-id` (the instance id).
 *
 * Every response is the envelope `{ code, message, request_id, data }`;
 * `code === 0` means success.
 */

import { isolationFields } from "./config.mjs";

export class CoreError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = "CoreError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class CoreClient {
  constructor(cfg) {
    this.cfg = cfg;
  }

  /** POST a data-plane endpoint, returning the unwrapped `data`. */
  async post(route, body = {}) {
    const { cfg } = this;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    const headers = {
      "content-type": "application/json",
      "x-tdai-service-id": cfg.serviceId,
    };
    if (cfg.kernelToken) headers.authorization = `Bearer ${cfg.kernelToken}`;

    try {
      const res = await fetch(`${cfg.endpoint}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...isolationFields(cfg), ...body }),
        signal: controller.signal,
      });

      const text = await res.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new CoreError(`${route}: non-JSON response (${res.status})`, { status: res.status });
      }

      if (!res.ok) {
        throw new CoreError(`${route}: HTTP ${res.status} — ${payload.message ?? text.slice(0, 200)}`, {
          status: res.status,
          code: payload.code,
          requestId: payload.request_id,
        });
      }
      if (payload.code !== 0) {
        throw new CoreError(`${route}: code ${payload.code} — ${payload.message}`, {
          status: res.status,
          code: payload.code,
          requestId: payload.request_id,
        });
      }
      return payload.data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── L0 ────────────────────────────────────────────────────────────────

  /**
   * Append raw conversation messages.
   *
   * The API caps a single call at 100 messages, so long turns are chunked.
   * Returns the total number of messages the server accepted.
   */
  async addConversation(sessionId, messages) {
    let accepted = 0;
    for (let i = 0; i < messages.length; i += 100) {
      const data = await this.post("/v3/conversation/add", {
        session_id: sessionId,
        messages: messages.slice(i, i + 100),
      });
      accepted += data?.total_count ?? 0;
    }
    return accepted;
  }

  searchConversation(query, limit = 10) {
    return this.post("/v3/conversation/search", { query, limit });
  }

  // ── L1 ────────────────────────────────────────────────────────────────

  searchAtomic(query, limit = 10) {
    return this.post("/v3/atomic/search", { query, limit });
  }

  queryAtomic(filter = {}) {
    return this.post("/v3/atomic/query", filter);
  }

  // ── L2 (scenario blocks) ──────────────────────────────────────────────

  listScenarios(pathPrefix) {
    return this.post("/v3/scenario/ls", pathPrefix ? { path_prefix: pathPrefix } : {});
  }

  readScenario(filePath) {
    return this.post("/v3/scenario/read", { path: filePath });
  }

  writeScenario(filePath, content, summary) {
    const body = { path: filePath, content };
    if (summary) body.summary = summary;
    return this.post("/v3/scenario/write", body);
  }

  // ── L3 (core persona) ─────────────────────────────────────────────────

  /** `content` is null when no persona has been written yet — not an error. */
  readCore() {
    return this.post("/v3/core/read", {});
  }

  writeCore(content) {
    return this.post("/v3/core/write", { content });
  }
}
