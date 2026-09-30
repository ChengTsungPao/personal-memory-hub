# Claude Code memory integration — current design

How Claude Code sessions map onto MemoryCore memory. Setup steps live in
`AGENTS.md`; hook/MCP details in `agents/claude-code/README.md`. This file is
the design reference — update it whenever the mapping below changes.

## Where the data lives

The single source of truth is a host folder, not Docker:
`~/.personal-memory-hub/core-data` (MemoryCore: SQLite, L0-L3, agent/user/team
metadata, vectors) and `~/.personal-memory-hub/panel-data` (Panel/knowledge).
The same folder holds `admin-key` (paired with the database) and `agents.json`
(project → agent map), so `~/.personal-memory-hub/` alone is the whole memory:
back it up or move it to another machine by copying that one folder (containers
stopped). Only machine-local capture cursors stay in `~/.memory-tdai/`.
Containers bind-mount it. Docker crash, `docker rm`, Docker Desktop reset or
reinstall cannot delete it. Lesson from 2026-09-30: a Docker named volume lives
inside Docker Desktop's virtual disk, and a Reset deleted all memory.

## Memory layers (per agent)

| Layer | What | Produced by |
|-------|------|-------------|
| L0 | raw conversation turns | `Stop` hook, every turn |
| L1 | atomic facts | pipeline, every 5 conversations or 10 min idle |
| L2 | scene blocks (several md files per topic) | pipeline, ~90 s after L1 |
| L3 | persona (one doc per agent) | pipeline, every 50 conversations |

## Session → agent mapping

- Unit of isolation is the **project**, not the session. A new session never
  creates an agent by itself.
- Project key: git `origin` remote hash → else git root-commit hash → else
  the shared `adhoc` bucket (agent name `adhoc-chat`).
- The key resolves to a real MemoryCore `agent_id` via
  `~/.personal-memory-hub/agents.json`. First sight of a new key calls
  `/v3/meta/agent/create` (needs the admin key), which also provisions that
  agent's single `chat_memory` asset (`chat_memory-{team}-{agent}`).
- Failure to register falls back to the `default` agent.
- `TDAI_AGENT_ID`, if set, overrides everything. It must not be set in the
  normal setup.

## When the binding is fixed

| Component | Agent resolved | Effect on already-open sessions |
|-----------|----------------|--------------------------------|
| Hooks | per event, from the session `cwd` | follow the project, but inherit the session's launch-time `env` (a stale `TDAI_AGENT_ID` still wins) |
| MCP server | once at startup, from its `process.cwd()` | stays on that agent until a new session |

Settings `env` and MCP connections are only read at session start.

## Cross-project reads (MCP)

The session is bound to its own agent, but read tools can target another:

- `agent_list` lists agents in the team (name + id).
- `memory_search`, `scenario_list`, `scenario_read`, `core_read` accept an
  optional `agent` (name or id). It is resolved via the agent list; an
  unknown value is an error, never a silent fallback.
- Writes (`scenario_write`, `core_write`) deliberately do **not** accept
  `agent`; they always target the session's own agent, so one project cannot
  overwrite another's memory by mistake.
- Listing agents uses the admin key (`TDAI_ADMIN_KEY_FILE`).

## LLM backends for L1–L3 extraction

`qwen` (local Ollama), `proxy` (claude-llm-proxy over a Claude subscription,
containerized), `openrouter`. Switched with
`deploy/global-images/switch-llm-backend.sh`; the Panel Guide page shows the
active backend and proxy cost stats. Embeddings: bge-m3 via Ollama.
