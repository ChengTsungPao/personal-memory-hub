# Memory extraction through llm-gateway async jobs

When the LLM backend is a local [llm-gateway](https://github.com/ChengTsungPao/llm-gateway) on one GPU,
background extraction competes with chats and agents. A synchronous request waited on an open socket,
timed out in the queue, and MemoryCore then reported the failed L1 call as an empty success and moved
the cursor past it: that conversation was never turned into memory. This mode fixes that.

Turn it on in `deploy/global-images/.env`:

```bash
MEMORY_LLM_ASYNC_JOBS=true        # only with llm-gateway as the LLM backend
```

## What changes

| | Before | Async job mode |
|---|---|---|
| LLM call | `POST /chat/completions`, waits | `POST /async/chat/completions` returns a job id; `GET /jobs/{id}` is polled (`async-job-fetch.ts`) |
| Timeout | counted from the request, queue included (180 s) | counted by the gateway from the moment generation starts |
| Transient errors | 5 s / 15 s / 45 s worker retries, then dropped | the gateway retries with an exponential backoff, then keeps the job as a dead letter |
| Failed L1 | empty success, cursor advanced, conversation lost | `L1ExtractionError`, cursor kept; the slice is tried again at the next trigger |
| Dedup step fails | everything stored as new | the whole slice fails (extraction and dedup succeed together or not at all) |
| Same slice twice | extracted twice | the same `dedup_key` returns the gateway's existing job |

Keys: `L1:<session>:<from>_<to>` (pipeline) and `L1S:...` (scavenger), where from / to are L0
`recorded_at` times in ms; each request appends `:extract` / `:dedup` and a hash of the request.

A dead letter is managed on llm-gateway's Models page: **Resume** runs it again; **Discard** drops it,
and MemoryCore then skips that slice on purpose. A job the gateway no longer knows (404, e.g. after its
data was reset) is submitted again.

## Idle scavenger

Every 30 minutes (`TDAI_SCAVENGER_INTERVAL_MS`; first run after 5 minutes) MemoryCore walks each
session's L0 history below its L1 cursor in 20-message windows. A window no L1 memory covers is
extracted again with priority `idle_only` — the gateway runs it only when nothing else is queued or
running — and its memories are stored without moving any cursor. Progress is kept in
`.metadata/l1-scavenger.json`, so each window is examined once. At most 3 windows are extracted per run.

## Fewer, larger batches

| Setting (`.env`) | Default now | Was |
|---|---|---|
| `MEMORY_L1_EVERY_N` | 15 rounds | 5 |
| `MEMORY_L1_WARMUP` | `false` | `true` (1 → 2 → 4 → ...) |
| `MEMORY_L1_IDLE_SECONDS` | 1800 s | 600 s |

A persona (L3) update reads at most 50 memories' worth of changed scenes, oldest first; the rest is
left for the next update instead of one prompt so long that it always timed out.

## Seeing it in the panel

Chat Memory marks each conversation message whose slice is still extracting with 🟡 and a failed one
with 🔴 (done: no mark). The L0 and L1 layer tabs show the counts, e.g. `🔴 2  🟡 1`. While anything is
🟡 the page refreshes the state every 10 seconds, and stops once nothing is. Data:
`POST /api/v1/chat-memory/l1-status` → MemoryCore `POST /v2/pipeline/l1-status` → llm-gateway `GET /v1/jobs`.

## Verify

```bash
docker logs tdai-memory-core 2>&1 | grep -E "async-job|scavenger|l1-failed"
curl -s http://127.0.0.1:8790/v1/jobs/stats      # llm-gateway: today's jobs, queue, dead letters
```
