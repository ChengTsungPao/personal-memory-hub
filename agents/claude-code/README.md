# Claude Code integration — hooks + MCP (no proxy)

This is a **replacement** for the upstream Claude Code integration. It exists
for one reason: the upstream design cannot be used with a Claude Pro/Max
subscription.

## What changed, and why

### Upstream: Claude Code goes through MemoryProxy

```
Claude Code ──► MemoryProxy ──► PROXY_UPSTREAM_URL (some LLM)
                    │
                    └─► MemoryCore   (captures L0 by intercepting the traffic)
```

Configured by overriding Claude Code's endpoint:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="sk-mem-..."
```

Two consequences follow from this, and both are fatal on a subscription plan:

1. **Setting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` puts Claude Code into
   API-key mode.** Your Pro OAuth login is bypassed by design — the two cannot
   both be active.
2. **The proxy must call an upstream model itself**, using
   `PROXY_UPSTREAM_API_KEY`. A subscription provides no API key to put there.

So under the upstream design the model answering you is *not* Claude — it is
whatever `PROXY_UPSTREAM_MODEL` points at, billed separately. The Pro
subscription goes unused.

### Here: Claude Code keeps its own connection; hooks do the memory

```
Claude Code ──────────────────────────────► Anthropic  (your Pro OAuth, untouched)
     │
     ├─ SessionStart hook ─► memory-recall.mjs  ─► MemoryCore   (inject L3 + L2 index)
     ├─ Stop hook ────────► memory-capture.mjs ─► MemoryCore   (append the turn to L0)
     └─ MCP server ───────► mcp/server.mjs      ─► MemoryCore   (search / curate on demand)
```

**MemoryProxy is not used at all.** Nothing sits between Claude Code and
Anthropic, no credential is extracted or forwarded, and the subscription works
normally.

### Concretely

| | Upstream | This integration |
|---|---|---|
| Model answering you | `PROXY_UPSTREAM_MODEL` (separate bill) | **Claude, your Pro plan** |
| `PROXY_UPSTREAM_API_KEY` | required | **not used** |
| L0 capture | proxy intercepts requests | `Stop` hook reads the transcript |
| Memory recall | proxy injects server-side | `SessionStart` hook + MCP tools |
| Services to run | memory-core + hub + proxy | **memory-core (+ hub for the panel)** |
| Changes to MemoryCore source | — | **none** |

`performAutoCapture()` / `performAutoRecall()` in `MemoryCore/src/core/hooks/`
were already host-neutral — the proxy was only ever one caller. This
integration is another caller, so no core code changed.

## What still needs an LLM

The proxy was one of *two* LLM dependencies upstream. This removes it. The other
one remains: MemoryCore's extraction pipeline
(`MEMORY_LLM_*`) drives L1 extraction, L1 conflict detection, L2 scene
generation and L3 persona synthesis.

Point it at a local Ollama and it costs nothing:

| Capability | Without an extraction LLM | With local Ollama |
|---|:---:|:---:|
| L0 conversation capture | works | works |
| Keyword search (BM25 / FTS) | works | works |
| Vector search | on — `bge-m3` via Ollama (see below) | same |
| L3 persona | readable + writable (can be created), **not auto-generated** | auto-generated |
| L2 scenario blocks | readable, and existing ones editable — but **cannot be created**: `/v3/scenario/write` refuses unknown paths (404), so only the pipeline makes new blocks | works |
| L1 atoms | **unavailable** — no create endpoint exists; only the pipeline makes them | works |
| L1 conflict detection, skill extraction, reports | unavailable | works |

MemoryCore's code does support a keyless local embedding provider
(`embeddinggemma-300m` via node-llama-cpp), but `start-memory-core.sh` writes
`embedding: provider: none`, so a stock deploy runs with vector search off and
retrieves by keyword only. Turning it on means editing that script's generated
config; that path has not been tested here.

## Setup

### 1. Run MemoryCore

`memory-core` is the only required service — the proxy is never started.

```bash
cd deploy/global-images
cp .env.example .env          # then set MEMORY_LLM_* (see step 2)
MSYS_NO_PATHCONV=1 bash start-memory-core.sh
```

**On Windows (Git Bash), `MSYS_NO_PATHCONV=1` is mandatory.** Without it Git
Bash rewrites the container-side path in `-v …:/data/config/tdai-gateway.yaml`
into `C:\Program Files\Git\data\config\…`, the config lands nowhere, and the
container silently falls back to its built-in `gpt-4o` / OpenAI config — every
extraction then fails with "You didn't provide an API key".

The script's own `init-admin` call also reports `HTTP=000` under Git Bash. If
it does, create the admin by hand:

```bash
KEY="sk-mem-$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
curl -X POST http://127.0.0.1:8420/v3/internal/meta/user/init-admin   -H "Content-Type: application/json" -H "Authorization: Bearer local"   -H "x-tdai-service-id: default"   -d "{\"username\":\"admin\",\"user_key\":\"$KEY\"}"
printf %s "$KEY" > .admin-key
```

Note the port (default `8420`) and the `sk-mem-…` user key it prints.

### 2. Ollama (recommended)

Ollama's default context window is 4096 tokens, which truncates extraction —
it has to read prior memories plus the new conversation in one call. Build a
variant with a larger window:

```bash
ollama pull qwen3:8b

cat > Modelfile <<'EOF'
FROM qwen3:8b
PARAMETER num_ctx 32768
PARAMETER temperature 0
EOF
ollama create qwen3-mem -f Modelfile
```

`qwen3:8b` at Q4 is about 5 GB, so a 12 GB card runs it with room for the
larger context. **Set `temperature 0`** — at the model's default of 0.6,
extraction produced malformed JSON in 2 of 5 runs; at 0 it was 1 in 10 (see
*Verified behaviour*). Qwen is the pick over Llama here because extraction is
JSON-structured and often Chinese.

Then point MemoryCore at it. **Use `host.docker.internal`, not `localhost`** —
inside the container `localhost` is the container:

```bash
MEMORY_LLM_BASE_URL=http://host.docker.internal:11434/v1
MEMORY_LLM_API_KEY=ollama        # Ollama ignores it, but it must not be empty
MEMORY_LLM_MODEL=qwen3-mem
MEMORY_LLM_PROTOCOL=openai
```

#### Why `qwen3:8b`, not a bigger model

L1 extraction, dedup and persona generation each have a **180-second timeout
hard-coded** in MemoryCore (`l1-extractor.ts`, `l1-dedup.ts`,
`persona-generator.ts`) — `llm.timeoutMs` in the generated config does not
apply to them. A model has to both fit on the GPU and finish inside that
window; "it can run slower in the background" only holds up to 180s.

Measured on an RTX 3060 12 GB, 6 extraction runs per config, real batches
(one 10-message batch reached 7,407 input chars):

| | `qwen3:8b` @ 32k ctx | `qwen3:14b` @ 8k ctx | `qwen3:14b` @ 16k/32k ctx |
|---|---|---|---|
| GPU placement | 100% GPU (9.8 GB) | 100% GPU (10 GB) | 13–28% spills to CPU |
| Extraction time | 68–148s | 92–164s | **all runs hit the 180s timeout** |
| Success rate | 6/6 | 4/6 (2 timeouts) | 0/6 |

14b only fits on the GPU at a context small enough (8k) that it starts
timing out anyway once the CPU-offload runs are included, and 8k is too small
for real batches regardless — see the capacity table below. 8b at 32k is the
only configuration that was both fully on-GPU and reliably under 180s.

#### Context capacity by model/setting

Chars-per-token measured directly against this Ollama instance (qwen3
tokenizer): Chinese 1.98, English 5.03, code 4.02 chars/token. Usable tokens
below subtract the ~2,660-token system prompt and a ~2,000-token output
reserve.

| Config | Usable tokens | ≈ Chinese chars | ≈ English chars | ≈ code lines |
|---|---:|---:|---:|---:|
| `qwen3:8b` @ 32k (recommended) | ~28,000 | ~55,000 | ~140,000 | ~1,600 |
| `qwen3:8b` @ 16k | ~11,700 | ~23,000 | ~59,000 | ~670 |
| `qwen3:14b` @ 8k | ~3,500 | ~6,900 | ~17,600 | ~200 |

MemoryCore batches up to 20 messages at 8,192 chars each, so a single L1
extraction call can legitimately need more than 14b @ 8k has room for —
content gets silently truncated rather than the call failing loudly.

### 3. Panel UI (optional, but you probably want it)

The browsable web panel does **not** need the proxy either — it talks to
MemoryCore directly, so it runs on its own:

```bash
docker run -d --name tdai-memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p 8125:8125 -p 8424:8424 \
  -v tdai-panel-data:/data/knowledge \
  -e REMOTE_INSTANCE_URL=http://host.docker.internal:8420 \
  -e REMOTE_INSTANCE_KEY=local \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  -e LLM_API_KEY=ollama \
  -e LLM_MODEL=qwen3-mem \
  docker.io/agentmemory/memory-hub:latest
```

On Windows use the repo script rather than the raw `docker run` above, and set
`MEMORY_HUB_PROXY_PUBLIC_URL` first — its host-IP detection calls
`ipconfig getifaddr` (a macOS command), Windows' `ipconfig.exe` answers with
its whole multi-line report instead, and the container crashes on the
resulting broken string:

```bash
echo "MEMORY_HUB_PROXY_PUBLIC_URL=http://127.0.0.1:8096" >> .env   # display-only; no proxy runs
MSYS_NO_PATHCONV=1 bash start-memory-hub.sh
```

Then open <http://localhost:8125> to browse teams, agents, and stored memory,
and to create the Team / Agent / User records whose ids go in the environment
below. Its `LLM_*` can point at the same local Ollama as MemoryCore.

That makes **two** containers — `memory-core` and `memory-hub` — against the
upstream stack's three. The proxy is the one that drops out.

### 4. Environment

The hooks and the MCP server read the same variables. Nothing is stored in a
settings file, so no secret is ever committed.

| Variable | Default | Meaning |
|---|---|---|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | MemoryCore base URL |
| `TDAI_SERVICE_ID` | `default` | Instance id (`x-tdai-service-id`) |
| `TDAI_KERNEL_TOKEN` | *(empty → sends `Bearer local`)* | Layer-1 gateway token. The gateway rejects a request with **no** `Authorization` header even when it has no apiKey — it just doesn't check the value — so an empty token still sends a placeholder, as MemoryProxy does |
| `TDAI_TEAM_ID` | `default` | Isolation triple — v3 requires team + agent + user. **Set this to the id the panel shows** (e.g. `team-…`): memory written under `default` is stored fine but is invisible in the panel, which browses by its own ids |
| `TDAI_AGENT_ID` | *(auto-derived, see below — set this only to force one fixed value)* | |
| `TDAI_USER_ID` | `default` | |
| `TDAI_TASK_ID` | *(unset)* | Optional; omitted from requests when empty |
| `TDAI_TIMEOUT_MS` | `8000` | Per-request timeout |
| `TDAI_STATE_DIR` | `~/.memory-tdai/claude-code` | Where capture cursors live |
| `TDAI_DEBUG` | *(unset)* | `1` logs hook diagnostics to stderr |

### Memory isolation: why `agent_id` is per-project, not per-session

**What `team_id` + `agent_id` actually mean.** Every layer of memory (L0
conversations, L1 atoms, L2 scene blocks, L3 persona) is partitioned by the
`(team_id, agent_id)` pair — see `MemoryCore/src/metadata/utils/chat-memory-asset.ts`,
which builds the storage key as literally `chat_memory-{team_id}-{agent_id}`.
This is **not** one bucket per chat session. It's one continuously-accumulating
memory per *agent identity* — the whole point of the L1→L2→L3 pipeline is to
synthesize many conversations, over time, into one coherent picture (L3 persona
regeneration alone triggers every 50 processed conversations; that only makes
sense across a large number of sessions). In the upstream multi-tenant design,
one `agent_id` is meant to represent one specific bot/assistant a team
registers (e.g. "our customer-support bot"), and everyone's conversations with
that one bot feed its one growing memory.

**The mistake we made setting this up.** The initial wiring pinned
`TDAI_TEAM_ID`/`TDAI_AGENT_ID` to one fixed pair in `~/.claude/settings.json`,
so *every* Claude Code session on the machine — regardless of which project it
was in — wrote into the same `agent_id`. This isn't just "everything shows up
under one name in the panel" — it actively degraded memory quality: L2 scene
blocks from completely unrelated projects (this repo, an unrelated LaTeX
project, an unrelated input-method side project, Docker networking notes, …)
all landed in the same bucket, and L3 persona regeneration was then asked to
synthesize one coherent "Team Operating Doctrine" out of all of them at once —
producing an incoherent mashup of unrelated rules (image-mirror policy next to
UAC-authorization rules next to an IME's UI design decisions) that then gets
injected as `additionalContext` into the *next* unrelated session's
`SessionStart`, regardless of what that session is actually about.

Naively fixing this by keying on **session_id instead** would be worse, not
better: session_id changes every time you open `claude`, so every session
would become an isolated island that can never see memory from any earlier
session — the L1/L2/L3 pipeline would have nothing to accumulate, defeating
the entire point of long-term memory.

**The actual fix: derive `agent_id` from the project's git identity.**
`lib/config.mjs`'s `loadConfig(cwd, sessionId)` now derives `agent_id`
automatically (only when `TDAI_AGENT_ID` isn't set explicitly), in order:

1. `git remote get-url origin`, hashed — stable across clones/worktrees of the
   same repo.
2. The repo's root commit hash (`git rev-list --max-parents=0 HEAD`) when
   there's no `origin` remote — unlike the working-directory path, this stays
   identical across `git worktree` checkouts of the same history, which a
   path-based key would incorrectly split apart.
3. `agt-{sessionId}` when `cwd` isn't inside a git repo at all — a one-off
   chat with no project has no stable identity to accumulate memory around
   anyway, so each such chat gets its own small bucket instead of dumping into
   one shared catch-all that would pollute every other unrelated one-off chat.
4. Literal `"default"` only when neither `cwd` nor `sessionId` is available
   (e.g. the MCP server, a long-lived process with no per-call session id,
   running outside any git repo).

The two hooks pass `payload.cwd` and `payload.session_id` from the hook's
stdin payload; the MCP server (a persistent process) uses its own
`process.cwd()` at launch. `team_id` and `user_id` stay fixed — only
`agent_id` (which project) varies.

### 5. Register the hooks

Copy `settings.template.json` into `~/.claude/settings.json` (or merge its
`hooks` and `env` blocks into what you already have), fixing the absolute paths.

### 6. Register the MCP server

```bash
claude mcp add memorycore -s user -- node /absolute/path/to/agents/claude-code/mcp/server.mjs
```

Restart Claude Code; `claude mcp list` should show `memorycore ✔ Connected`.

## Verified behaviour

Run end-to-end on Windows 11, Docker Desktop 27, Ollama 0.33 with `qwen3:8b`
on an RTX 3060 12 GB.

| Step | Result |
|---|---|
| `Stop` hook → `/v3/conversation/add` | L0 stored; content byte-identical, Chinese intact |
| Repeat `Stop` on the same transcript | 0 re-sent (cursor) |
| New turn appended | only that turn sent |
| MemoryCore down | both hooks exit 0, print nothing, cursor not advanced |
| L1 extraction (Ollama) | atoms stored in ~70–150 s per batch (`qwen3:8b` @ 32k, 6-run sample) |
| L2 scene generation | scene `.md` files created automatically |
| L3 persona generation | `persona.md` written (≈2.7 k chars, ≈70 s) |
| `SessionStart` hook | injects persona + scene index as `additionalContext` |
| MCP `memory_search` / `scenario_list` / `core_read` / `core_write` | work |
| Panel UI | shows L0 / L1 / L2 once the env ids match the panel's |
| Container recreate | admin user and L1 atoms persist (named volume) |

Things that behave differently from what you might assume — each found by
running it, not by reading the docs:

- **The gateway needs an `Authorization` header even with no apiKey set.** It
  just doesn't check the value. The client sends `Bearer local` when
  `TDAI_KERNEL_TOKEN` is empty, as MemoryProxy does.
- **`timestamp` / `recorded_at` must be ISO strings.** Epoch numbers get a 400.
- **`/v3/scenario/write` cannot create a block** — it 404s on unknown paths.
  New L2 blocks come only from the pipeline, so without an extraction LLM there
  is no L2 at all. L3 (`/v3/core/write`) *can* be created directly.
- **Extraction with `qwen3:8b` sometimes emits malformed JSON.** Every failure
  corrupted the same key (`activity_end_time` → `activity_end,`). Default
  temperature: 3/5 batches parsed; temperature 0: 9/10. Upstream marks a
  failed batch as extracted anyway, so its L0 is kept but its L1 is never
  retried. `qwen3:14b` does **not** fix this — see *Why `qwen3:8b`, not a
  bigger model* above: it either times out (180s hard-coded limit) or, at a
  context small enough to stay on-GPU, has too little room for a real batch.
- **L1 dedup is session-scoped** (upstream design, `l1-dedup.ts`). The same
  fact stated in two different sessions is stored twice; L2 aggregation is
  what consolidates it.
- **L1 is written in Simplified Chinese** — upstream's extraction prompts are.

## Data locality / network exposure

**No Tencent Cloud VectorDB.** `storeBackend: sqlite` in the generated config;
`docker inspect` on the running containers shows no `tcvdb`/`tencent`-related
env var. Storage is a local SQLite file on a named Docker volume.

**Nothing in this deployment is configured to call an external service.**
`MEMORY_LLM_*` points at local Ollama; `PROXY_*` is set to `unused` and the
proxy is never started (see *What changed, and why* — that's the entire point
of this integration); no `OPENAI_API_KEY`, telemetry endpoint, or other
outbound credential is set anywhere in `.env` or the container env. So today,
nothing actually leaves the machine.

**That said, the containers technically *can* reach the real internet** — a
plain Docker bridge network NATs outbound traffic by default, and `curl
https://www.google.com` from inside `tdai-memory-core` returns 200. Nothing
*uses* that path, but it exists. Two attempts to close it off at the Docker
network layer, both tested and both rejected because they broke required
connectivity — Docker Desktop on Windows/WSL2 routes host↔container traffic
through the *same* NAT boundary as container↔internet traffic, so blocking one
blocks the other:

| Approach | Blocks internet | Host → Panel (`-p` ports) | Container → Ollama (`host.docker.internal`) |
|---|:---:|:---:|:---:|
| `docker network create --internal` | ✅ | ❌ broken | ❌ broken |
| `-o com.docker.network.bridge.enable_ip_masquerade=false` | ✅ | ✅ | ❌ broken |

Neither is usable as-is: the first kills the Panel, the second kills
extraction. The clean fix would be running Ollama in a container on the same
Docker network as MemoryCore — extraction traffic becomes container↔container
(verified working above, unaffected by either restriction) instead of crossing
the host boundary at all, and the network could then genuinely block internet
egress. That requires GPU passthrough into a container under WSL2 (NVIDIA
Container Toolkit), which has not been set up or tested here, so it's left as
a known next step rather than done speculatively.

## Design notes

**The `Stop` hook fires every turn.** Sending the whole transcript each time
would re-write the entire history on every message, so a cursor file per
session (`TDAI_STATE_DIR/<hash>.cursor`) records the last transcript `uuid`
shipped, and only later entries are sent. The cursor advances only after a
successful write, so a transient outage is retried rather than dropped. If the
cursor is not found — a `/clear`, or a replaced transcript — the file is
re-read from the top rather than silently capturing nothing.

**Hooks never block a turn.** Every failure path exits 0 with no stdout. A
memory backend that is down, slow or misconfigured is an inconvenience, not a
reason to interrupt someone's work. Set `TDAI_DEBUG=1` to see why something is
quiet.

**What gets captured.** Only `user` and `assistant` entries with actual prose.
`thinking` blocks are private reasoning, `tool_use` / `tool_result` blocks are
machine payloads that would bloat L0 without improving recall, and
`isSidechain` entries belong to subagents' own conversations.

**What `SessionStart` injects.** The L3 persona and the L2 *index* (paths and
summaries) — not L0 or L1. Those are large and query-specific, so the MCP
server fetches them on demand instead of spending context up front on memories
the session may never need. `source: "compact"` is skipped, since the memory is
already in context.

## Files

| Path | Purpose |
|---|---|
| `hooks/memory-capture.mjs` | `Stop` → append the turn to L0 |
| `hooks/memory-recall.mjs` | `SessionStart` → inject L3 + L2 index |
| `mcp/server.mjs` | MCP stdio server: search, scenario read/write, core read/write |
| `lib/config.mjs` | Environment loading, isolation fields |
| `lib/core-client.mjs` | MemoryCore v3 data-plane client |
| `lib/transcript.mjs` | Transcript parsing + capture cursor |
| `settings.template.json` | Hook registration to merge into `~/.claude/settings.json` |

All of it is plain Node ESM with **no dependencies** — Node's built-in `fetch`
and `node:fs` only, so it runs wherever Claude Code runs without an install
step.
