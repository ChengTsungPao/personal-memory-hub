/**
 * Async job transport for the standalone LLM runner (TDAI_LLM_ASYNC_JOBS=true).
 *
 * With llm-gateway as the LLM backend, a synchronous /chat/completions request waits on an open socket
 * while the gateway's single GPU serves chats and agents first, so background extraction timed out in
 * the queue and its work was lost. In async mode every chat completion the AI SDK sends is instead
 *
 *   1. submitted to `POST {base}/async/chat/completions` (returns a job id at once),
 *   2. polled with `GET {base}/jobs/{id}` until it is finished,
 *
 * and the job's result is handed back to the AI SDK as if the request had answered directly. Queue time
 * is not timed; the gateway times only the generation (`timeout_s`) and retries transient failures with
 * a backoff. The gateway contract is documented in llm-gateway's docs/async-jobs.md.
 *
 * Outcomes:
 *   succeeded  → the completion is returned
 *   failed     → LlmJobFailedError (a fatal error; the gateway will not retry it)
 *   suspended  → LlmJobFailedError (a dead letter after repeated transient failures)
 *   discarded  → LlmJobDiscardedError (the user dropped this work in the gateway UI)
 *   404        → the gateway lost the job (e.g. it was reset): submitted again with the same key
 *
 * A `dedupKey` makes resubmission idempotent: each request's key is `<dedupKey>:<hash of the request>`,
 * so a retry of the same request finds the job that already exists, while the different requests of a
 * multi-step tool loop stay separate jobs.
 */

import { createHash } from "node:crypto";
import type { Logger } from "../../core/types.js";

export type JobPriority = "high" | "normal" | "idle_only";

export class LlmJobFailedError extends Error {
  constructor(message: string, readonly status: string, readonly kind?: string) {
    super(message);
    this.name = "LlmJobFailedError";
  }
}

/** The user discarded this job in the gateway: the work is dropped on purpose, not failed. */
export class LlmJobDiscardedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmJobDiscardedError";
  }
}

export function asyncJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TDAI_LLM_ASYNC_JOBS ?? "").toLowerCase() === "true";
}

export interface AsyncJobFetchOptions {
  priority: JobPriority;
  dedupKey?: string;
  /** Generation timeout for the gateway, in ms (queue time is not counted). */
  timeoutMs: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** How many times a job the gateway lost (404) is submitted again before giving up. */
  maxResubmits?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

interface JobView {
  id: string;
  status: string;
  error?: string | null;
  error_kind?: string | null;
  attempts?: number;
  result?: unknown;
}

const TAG = "[memory-tdai] [async-job]";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function requestKey(dedupKey: string, body: unknown): string {
  return `${dedupKey}:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12)}`;
}

/** A `fetch` for the AI SDK provider that turns chat completions into gateway jobs. */
export function createAsyncJobFetch(opts: AsyncJobFetchOptions): typeof fetch {
  const doFetch = opts.fetchImpl ?? fetch;
  const pollStart = opts.pollIntervalMs ?? Number(process.env.TDAI_LLM_ASYNC_POLL_MS ?? 2000);
  const pollMax = opts.maxPollIntervalMs ?? 10_000;
  const maxResubmits = opts.maxResubmits ?? 3;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || !url.replace(/\/+$/, "").endsWith("/chat/completions")) {
      return doFetch(input, init);
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (body.stream) return doFetch(input, init); // jobs are non-streaming; keep a streaming caller working

    const base = url.replace(/\/+$/, "").slice(0, -"/chat/completions".length);
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    const key = opts.dedupKey ? requestKey(opts.dedupKey, body) : undefined;
    const signal = opts.signal;

    const submit = async (): Promise<JobView> => {
      const r = await doFetch(`${base}/async/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          ...body,
          priority: opts.priority,
          ...(key ? { dedup_key: key } : {}),
          timeout_s: Math.max(1, Math.round(opts.timeoutMs / 1000)),
        }),
      });
      if (!r.ok) {
        throw new LlmJobFailedError(`async submit failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`,
          "submit_error");
      }
      return (await r.json()) as JobView;
    };

    let job = await submit();
    opts.logger?.debug?.(`${TAG} submitted job=${job.id} priority=${opts.priority} key=${key ?? "-"} status=${job.status}`);
    let resubmits = 0;
    let interval = pollStart;
    for (;;) {
      switch (job.status) {
        case "succeeded":
          return new Response(JSON.stringify(job.result ?? {}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        case "failed":
        case "suspended":
          throw new LlmJobFailedError(
            `LLM job ${job.id} ${job.status === "suspended" ? "suspended after " + (job.attempts ?? "?") + " attempts" : "failed"}` +
              ` (${job.error_kind ?? "error"}): ${job.error ?? ""}`,
            job.status,
            job.error_kind ?? undefined,
          );
        case "discarded":
          throw new LlmJobDiscardedError(`LLM job ${job.id} was discarded in the gateway`);
        default:
          break; // queued | running: keep polling
      }
      await sleep(interval, signal);
      interval = Math.min(pollMax, Math.round(interval * 1.5));
      let r: Response;
      try {
        r = await doFetch(`${base}/jobs/${encodeURIComponent(job.id)}`, { headers, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        opts.logger?.warn?.(`${TAG} poll job=${job.id} failed (${String(err)}); polling again`);
        continue; // the gateway restarting: the job is persisted there, so just ask again
      }
      if (r.status === 404) {
        // the gateway no longer knows the job (reset): it is lost, not pending forever
        resubmits += 1;
        if (resubmits > maxResubmits) {
          throw new LlmJobFailedError(`LLM job ${job.id} lost by the gateway ${resubmits} times`, "lost");
        }
        opts.logger?.warn?.(`${TAG} job=${job.id} not found at the gateway; submitting again (${resubmits}/${maxResubmits})`);
        job = await submit();
        interval = pollStart;
        continue;
      }
      if (!r.ok) {
        opts.logger?.warn?.(`${TAG} poll job=${job.id} HTTP ${r.status}; polling again`);
        continue;
      }
      job = (await r.json()) as JobView;
    }
  }) as typeof fetch;
}
