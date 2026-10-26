/**
 * POST /v2/pipeline/l1-status — which conversation slices are still being extracted, and which failed.
 *
 * Async job mode only (TDAI_LLM_ASYNC_JOBS=true). Every L1 extraction is a job at the LLM gateway whose
 * dedup key names its slice: `L1:<session>:<from>_<to>:...` (pipeline) or `L1S:...` (idle scavenger),
 * where from / to are L0 `recorded_at` times in ms (exclusive / inclusive). This endpoint lists the
 * gateway's unfinished and failed L1 jobs and turns them into slices, so a UI can mark each message:
 *
 *   pending  queued or running at the gateway (🟡)
 *   failed   failed or suspended (dead letter), waiting to be resumed or picked up by the scavenger (🔴)
 *
 * Body: { session_ids?: string[] } — limits the answer to these sessions.
 */

import type { ApiResponseEnvelope } from "./v2-schemas.js";

export interface L1JobSlice {
  session_id: string;
  from: number;
  to: number;
  status: "pending" | "failed";
  kind: "pipeline" | "scavenger";
  error?: string;
  attempts?: number;
  job_ids: string[];
}

interface GatewayJob {
  id: string;
  dedup_key?: string | null;
  status: string;
  error?: string | null;
  attempts?: number;
}

/** `L1:<session>:<from>_<to>[:step...]` → its parts; session ids may themselves contain ':'. */
export function parseL1JobKey(key: string): { kind: "pipeline" | "scavenger"; sessionId: string; from: number; to: number } | null {
  const m = /^(L1S?):(.+):(\d+)_(\d+)(?::.*)?$/.exec(key);
  if (!m) return null;
  return { kind: m[1] === "L1S" ? "scavenger" : "pipeline", sessionId: m[2], from: Number(m[3]), to: Number(m[4]) };
}

/** Merge the jobs of one slice (extract + dedup steps): failed wins over pending. */
export function slicesFromJobs(jobs: GatewayJob[], sessionIds?: Set<string>): L1JobSlice[] {
  const bySlice = new Map<string, L1JobSlice>();
  for (const job of jobs) {
    const parsed = job.dedup_key ? parseL1JobKey(job.dedup_key) : null;
    if (!parsed) continue;
    if (sessionIds && sessionIds.size > 0 && !sessionIds.has(parsed.sessionId)) continue;
    const status: L1JobSlice["status"] | null =
      job.status === "queued" || job.status === "running" ? "pending"
        : job.status === "failed" || job.status === "suspended" ? "failed"
          : null;
    if (!status) continue;
    const id = `${parsed.kind}|${parsed.sessionId}|${parsed.from}|${parsed.to}`;
    const slice = bySlice.get(id) ?? {
      session_id: parsed.sessionId, from: parsed.from, to: parsed.to, status, kind: parsed.kind, job_ids: [],
    };
    slice.job_ids.push(job.id);
    if (status === "failed") {
      slice.status = "failed";
      slice.error = job.error ?? slice.error;
      slice.attempts = job.attempts ?? slice.attempts;
    }
    bySlice.set(id, slice);
  }
  return [...bySlice.values()].sort((a, b) => a.from - b.from);
}

export async function handlePipelineL1Status(
  body: unknown,
  requestId: string,
  llmJobs: { baseUrl: string; apiKey: string } | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResponseEnvelope> {
  const ok = (data: unknown): ApiResponseEnvelope =>
    ({ code: 0, message: "ok", request_id: requestId, data });
  if (!llmJobs) return ok({ enabled: false, slices: [] });

  const raw = (body as { session_ids?: unknown } | null)?.session_ids;
  const sessionIds = new Set(
    Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 500) : [],
  );
  const base = llmJobs.baseUrl.replace(/\/+$/, "");
  try {
    const r = await fetchImpl(`${base}/jobs?status=queued,running,suspended,failed&key_prefix=L1&limit=500`, {
      headers: llmJobs.apiKey ? { authorization: `Bearer ${llmJobs.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return ok({ enabled: true, reachable: false, slices: [], error: `LLM gateway HTTP ${r.status}` });
    const jobs = ((await r.json()) as { jobs?: GatewayJob[] }).jobs ?? [];
    return ok({ enabled: true, reachable: true, slices: slicesFromJobs(jobs, sessionIds) });
  } catch (err) {
    return ok({ enabled: true, reachable: false, slices: [], error: err instanceof Error ? err.message : String(err) });
  }
}
