import { describe, expect, it } from "vitest";
import {
  LlmJobDiscardedError,
  LlmJobFailedError,
  asyncJobsEnabled,
  createAsyncJobFetch,
  requestKey,
} from "./async-job-fetch.js";

const BASE = "http://gw/v1";
const OK = { choices: [{ message: { role: "assistant", content: "done" } }] };

/** A fake llm-gateway: scripted job states per poll, records every request. */
function gateway(script: Array<Record<string, unknown> | 404>) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let submitted = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/async/chat/completions")) {
      submitted += 1;
      return Response.json({ id: `job${submitted}`, status: "queued" }, { status: 202 });
    }
    if (url.includes("/jobs/")) {
      const next = script.shift();
      if (next === 404 || next === undefined) return new Response("{}", { status: 404 });
      return Response.json({ id: "job", ...next });
    }
    return Response.json({ passthrough: true });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function post(f: typeof fetch, body: Record<string, unknown>) {
  return f(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer k" },
    body: JSON.stringify(body),
  });
}

describe("async job fetch", () => {
  it("submits a job, polls until it succeeds, and answers like the sync endpoint", async () => {
    const gw = gateway([{ status: "queued" }, { status: "running" }, { status: "succeeded", result: OK }]);
    const f = createAsyncJobFetch({ priority: "normal", dedupKey: "L1:s:0_9", timeoutMs: 180_000, pollIntervalMs: 1, fetchImpl: gw.fetchImpl });
    const r = await post(f, { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(await r.json()).toEqual(OK);
    const submit = gw.calls[0];
    expect(submit.url).toBe(`${BASE}/async/chat/completions`);
    expect(submit.body).toMatchObject({ model: "m", priority: "normal", timeout_s: 180 });
    expect(submit.body.dedup_key).toBe(requestKey("L1:s:0_9", { model: "m", messages: [{ role: "user", content: "hi" }] }));
    expect(gw.calls.filter((c) => c.url.includes("/jobs/")).length).toBe(3);
  });

  it("gives every request of a multi-step call its own stable key", () => {
    const a = requestKey("L2:s", { messages: [1] });
    expect(requestKey("L2:s", { messages: [1] })).toBe(a);
    expect(requestKey("L2:s", { messages: [1, 2] })).not.toBe(a);
    expect(a.startsWith("L2:s:")).toBe(true);
  });

  it("treats a job the gateway lost (404) as lost and submits it again", async () => {
    const gw = gateway([404, { status: "succeeded", result: OK }]);
    const f = createAsyncJobFetch({ priority: "normal", dedupKey: "k", timeoutMs: 1000, pollIntervalMs: 1, fetchImpl: gw.fetchImpl });
    expect(await (await post(f, { messages: [] })).json()).toEqual(OK);
    expect(gw.calls.filter((c) => c.url.endsWith("/async/chat/completions")).length).toBe(2);
  });

  it("gives up when the job keeps disappearing", async () => {
    const gw = gateway([404, 404, 404]);
    const f = createAsyncJobFetch({ priority: "normal", timeoutMs: 1000, pollIntervalMs: 1, maxResubmits: 2, fetchImpl: gw.fetchImpl });
    await expect(post(f, { messages: [] })).rejects.toBeInstanceOf(LlmJobFailedError);
  });

  it("reports a dead letter and a fatal failure as errors, a discarded job as discarded", async () => {
    for (const status of ["suspended", "failed"]) {
      const gw = gateway([{ status, attempts: 5, error: "timed out", error_kind: "timeout" }]);
      const f = createAsyncJobFetch({ priority: "normal", timeoutMs: 1000, pollIntervalMs: 1, fetchImpl: gw.fetchImpl });
      await expect(post(f, { messages: [] })).rejects.toMatchObject({ name: "LlmJobFailedError", status });
    }
    const gw = gateway([{ status: "discarded" }]);
    const f = createAsyncJobFetch({ priority: "idle_only", timeoutMs: 1000, pollIntervalMs: 1, fetchImpl: gw.fetchImpl });
    await expect(post(f, { messages: [] })).rejects.toBeInstanceOf(LlmJobDiscardedError);
  });

  it("leaves other requests and streaming requests alone", async () => {
    const gw = gateway([]);
    const f = createAsyncJobFetch({ priority: "normal", timeoutMs: 1000, fetchImpl: gw.fetchImpl });
    expect(await (await f(`${BASE}/models`)).json()).toEqual({ passthrough: true });
    expect(await (await post(f, { stream: true, messages: [] })).json()).toEqual({ passthrough: true });
    expect(gw.calls.every((c) => !c.url.includes("/async/"))).toBe(true);
  });

  it("is switched on by TDAI_LLM_ASYNC_JOBS=true only", () => {
    expect(asyncJobsEnabled({ TDAI_LLM_ASYNC_JOBS: "true" })).toBe(true);
    expect(asyncJobsEnabled({ TDAI_LLM_ASYNC_JOBS: "TRUE" })).toBe(true);
    expect(asyncJobsEnabled({})).toBe(false);
    expect(asyncJobsEnabled({ TDAI_LLM_ASYNC_JOBS: "1" })).toBe(false);
  });
});
