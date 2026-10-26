import { describe, expect, it } from "vitest";
import { handlePipelineL1Status, parseL1JobKey, slicesFromJobs } from "./pipeline-l1-status.js";

describe("L1 job status for the panel", () => {
  it("reads the slice out of a job key", () => {
    expect(parseL1JobKey("L1:sess-1:100_200:extract:ab12")).toEqual({ kind: "pipeline", sessionId: "sess-1", from: 100, to: 200 });
    expect(parseL1JobKey("L1S:a:b:0_50:dedup:cd34")).toEqual({ kind: "scavenger", sessionId: "a:b", from: 0, to: 50 });
    expect(parseL1JobKey("L2:x:1_2")).toBeNull();
    expect(parseL1JobKey("whatever")).toBeNull();
  });

  it("merges the steps of a slice; a failed step makes the slice failed", () => {
    const slices = slicesFromJobs([
      { id: "j1", dedup_key: "L1:s1:0_10:extract:aa", status: "succeeded" },
      { id: "j2", dedup_key: "L1:s1:0_10:dedup:bb", status: "suspended", error: "timed out", attempts: 5 },
      { id: "j3", dedup_key: "L1:s1:10_20:extract:cc", status: "running" },
      { id: "j4", dedup_key: "L1:s2:0_10:extract:dd", status: "queued" },
      { id: "j5", dedup_key: null, status: "queued" },
    ], new Set(["s1"]));
    expect(slices).toEqual([
      { session_id: "s1", from: 0, to: 10, status: "failed", kind: "pipeline", error: "timed out", attempts: 5, job_ids: ["j2"] },
      { session_id: "s1", from: 10, to: 20, status: "pending", kind: "pipeline", job_ids: ["j3"] },
    ]);
  });

  it("asks the gateway for unfinished and failed L1 jobs; says when it is off or unreachable", async () => {
    let asked = "";
    const fetchImpl = (async (url: string) => {
      asked = String(url);
      return Response.json({ jobs: [{ id: "j", dedup_key: "L1:s:1_2:extract:x", status: "queued" }] });
    }) as unknown as typeof fetch;
    const r = await handlePipelineL1Status({ session_ids: ["s"] }, "rid", { baseUrl: "http://gw/v1/", apiKey: "k" }, fetchImpl);
    expect(asked).toBe("http://gw/v1/jobs?status=queued,running,suspended,failed&key_prefix=L1&limit=500");
    expect((r.data as any).slices).toHaveLength(1);

    expect((await handlePipelineL1Status({}, "rid", undefined)).data).toEqual({ enabled: false, slices: [] });
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await handlePipelineL1Status({}, "rid", { baseUrl: "http://gw/v1", apiKey: "" }, down)).data)
      .toMatchObject({ enabled: true, reachable: false, slices: [] });
  });
});
