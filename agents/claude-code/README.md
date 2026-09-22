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
| Vector search (local `embeddinggemma-300m`, bundled) | works | works |
| BM25 / keyword search | works | works |
| L2 scenario blocks, L3 persona | readable + writable, **not auto-generated** | auto-generated |
| L1 atoms | **unavailable** — no create endpoint exists; only the pipeline makes them | works |
| L1 conflict detection, skill extraction, reports | unavailable | works |

Embeddings never need a key either way: MemoryCore bundles a local
`embeddinggemma-300m` GGUF and falls back to it when no remote embedding is
configured.

## Setup

### 1. Run MemoryCore

`memory-core` is the only required service — the proxy is never started.

```bash
deploy/global-images/start-memory-core.sh
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
EOF
ollama create qwen3-mem -f Modelfile
```

`qwen3:8b` at Q4 is about 5 GB, so a 12 GB card runs it with room for the
larger context. Qwen is the pick over Llama here because extraction is
JSON-structured and often Chinese.

Then point MemoryCore at it. **Use `host.docker.internal`, not `localhost`** —
inside the container `localhost` is the container:

```bash
MEMORY_LLM_BASE_URL=http://host.docker.internal:11434/v1
MEMORY_LLM_API_KEY=ollama        # Ollama ignores it, but it must not be empty
MEMORY_LLM_MODEL=qwen3-mem
MEMORY_LLM_PROTOCOL=openai
```

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
| `TDAI_KERNEL_TOKEN` | *(empty)* | Layer-1 gateway bearer token, if the gateway sets one |
| `TDAI_TEAM_ID` | `default` | Isolation triple — v3 requires team + agent + user |
| `TDAI_AGENT_ID` | `default` | |
| `TDAI_USER_ID` | `default` | |
| `TDAI_TASK_ID` | *(unset)* | Optional; omitted from requests when empty |
| `TDAI_TIMEOUT_MS` | `8000` | Per-request timeout |
| `TDAI_STATE_DIR` | `~/.memory-tdai/claude-code` | Where capture cursors live |
| `TDAI_DEBUG` | *(unset)* | `1` logs hook diagnostics to stderr |

### 5. Register the hooks

Copy `settings.template.json` into `~/.claude/settings.json` (or merge its
`hooks` and `env` blocks into what you already have), fixing the absolute paths.

### 6. Register the MCP server

```bash
claude mcp add memorycore -s user -- node /absolute/path/to/agents/claude-code/mcp/server.mjs
```

Restart Claude Code; `claude mcp list` should show `memorycore ✔ Connected`.

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
