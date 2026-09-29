# AGENTS.md — setup reference for this repo

Canonical, cross-harness setup checklist for this deployment (personal use,
this machine or a fresh one). `CLAUDE.md` just points here — this file is
the one source of truth, keep it up to date instead of duplicating steps
elsewhere. Written to be followed by any coding agent (Claude Code, Codex,
etc.) on any OS — everything below is plain bash/Docker/Node, nothing here
is Claude-Code-specific except step 5.

**Bringing secrets over from another machine:** none of the steps below
*require* it — every secret is either generated fresh on first run
(`.admin-key`) or obtained interactively per-machine (`claude setup-token`,
an OpenRouter key). If you're migrating an *existing* deployment (want to
keep the same MemoryCore data/identity rather than start fresh), drop the
files listed under "if migrating" into a `setup/` folder at the repo root
(gitignored — create it only if you actually have files to put there) and
this doc tells you where each one goes.

## 1. Core services (memory-core, memory-hub, Panel)

```bash
cd deploy/global-images
cp .env.example .env
```

Fill in `.env`:
- `MEMORY_LLM_*` — leave as-is for now, step 3 sets this properly via
  `switch-llm-backend.sh`.
- Everything else has sane defaults (ports, image tags, volume names).

*If migrating:* copy over `.admin-key` (keeps the same admin identity/data)
into `setup/`, then `cp setup/.admin-key deploy/global-images/.admin-key`
before first run — otherwise a fresh random one gets generated (fine for a
new deployment, but a fresh key can't `x-tdai-user-key`-authenticate against
data written under the old one).

```bash
MSYS_NO_PATHCONV=1 bash start-all.sh   # or start-memory-core.sh + start-memory-hub.sh separately
```

**Windows Git Bash: `MSYS_NO_PATHCONV=1` is mandatory** — without it the
generated `tdai-gateway.yaml` config mount silently lands nowhere and
memory-core falls back to a broken built-in `gpt-4o` config. Not needed on
macOS/Linux.

Full detail: `agents/claude-code/README.md` "Setup" section 1.

## 2. Vector search (embedding)

```bash
ollama pull bge-m3
```

Uncomment the `MEMORY_EMBEDDING_*` block in `.env` (already points at
`bge-m3` via Ollama's OpenAI-compatible endpoint by default). Re-run
`start-memory-core.sh` to pick it up. Skip this entirely to run
keyword-only (BM25) search instead — everything still works, just without
semantic ranking.

## 3. Pick an LLM backend for L1/L2/L3 extraction

```bash
cd deploy/global-images
./switch-llm-backend.sh status   # see what's active now
```

Three options, `./switch-llm-backend.sh <name>`:

- **`qwen`** — local Ollama, free, no external account needed. One-time model
  build first (larger context window than Ollama's 4096 default; see
  `agents/claude-code/README.md` "2. Ollama"):
  ```bash
  ollama pull qwen3:8b
  cat > Modelfile <<'EOF'
  FROM qwen3:8b
  PARAMETER num_ctx 32768
  PARAMETER temperature 0
  EOF
  ollama create qwen3-mem -f Modelfile
  ```
- **`proxy`** — runs L1 (and L2/L3, via a tool-calling emulation layer) on a
  Claude Pro/Max subscription instead of an API key. Setup:
  ```bash
  cd deploy/claude-llm-proxy
  cp .env.example .env
  claude setup-token   # interactive browser OAuth — must run in a real terminal,
                        # not through another agent's tool-call shell (no tty)
  # paste the printed sk-ant-oat01-... token into .env as CLAUDE_CODE_OAUTH_TOKEN
  bash run-docker.sh    # builds + runs as a container (--restart unless-stopped)
  ```
  *If migrating:* you can instead copy an existing `deploy/claude-llm-proxy/.env`
  into `setup/` and use it directly — OAuth tokens from `claude setup-token`
  are long-lived, no need to regenerate per machine. Full detail + known
  limitations (tool-calling emulation is unverified against a live L2/L3
  trigger; the container's own `/control/backend` switch endpoint has an
  unresolved Docker-outside-of-Docker path issue): `deploy/claude-llm-proxy/server.mjs`
  header comment and `deploy/claude-llm-proxy/run-docker.sh` header comment.
- **`openrouter`** — a real OpenAI-compatible API, native tool-calling, no
  workarounds. Set `OPENROUTER_API_KEY` (from openrouter.ai/keys) and
  `OPENROUTER_MODEL` (e.g. `anthropic/claude-sonnet-4.5`) in `.env` first.

## 4. Panel UI (optional but recommended)

```bash
cd MemoryPanel
cp config/metadata-instances.example.json config/metadata-instances.json
# point gateway_endpoint at http://host.docker.internal:8420, api_key: "local"
bash docker/local/run-local.sh
```

Mobile-responsive, Traditional Chinese fork of the upstream Panel — port
8123. Full detail: `MemoryPanel/README.mobile.md`.

## 5. Claude Code integration (hooks + MCP) — Claude-Code-specific

Only Claude Code is wired here. The two hooks (auto-capture every turn,
auto-inject memory at session start) have no equivalent set up for other
harnesses; for those, only the MCP server (5c) applies, and that hasn't
been tested outside Claude Code.

### 5a. Get your real team_id / user_id

Both must be real ids, not `default`: `TDAI_USER_ID` becomes the owner when
a new per-project agent is auto-registered, and a non-existent owner makes
that registration fail — everything then silently collapses back into one
`"default"` bucket.

```bash
# user_id — from the admin key generated in step 1
curl -s -X POST http://127.0.0.1:8420/v3/meta/auth/verify \
  -H "Content-Type: application/json" -H "x-tdai-service-id: default" \
  -d "{\"user_key\":\"$(cat deploy/global-images/.admin-key)\"}"
# -> data.user.user_id, e.g. usr-xxxxxxxxxx
```

`team_id`: shown under the team name in the Panel's top-left switcher
(e.g. `team-xxxxxxxxxx`).

### 5b. Hooks — add to `~/.claude/settings.json`

Merge these two blocks into the existing file (don't replace it — other
tools may have their own hooks there). Replace `<REPO>` with this repo's
absolute path (forward slashes on Windows, e.g.
`C:/Users/you/personal-memory-hub`) and fill in the ids from 5a:

```json
{
  "env": {
    "TDAI_ENDPOINT": "http://127.0.0.1:8420",
    "TDAI_SERVICE_ID": "default",
    "TDAI_TEAM_ID": "<team-id>",
    "TDAI_USER_ID": "<user-id>"
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
        "type": "command", "command": "node",
        "args": ["<REPO>/agents/claude-code/hooks/memory-recall.mjs"],
        "timeout": 10, "statusMessage": "Loading long-term memory..."
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
        "type": "command", "command": "node",
        "args": ["<REPO>/agents/claude-code/hooks/memory-capture.mjs"],
        "timeout": 15
      } ] }
    ]
  }
}
```

- `SessionStart` → `memory-recall.mjs`: injects this project's L3 persona +
  L2 scene index into the new session. Injects nothing until the project
  has accumulated enough conversations for the pipeline to build L2/L3.
- `Stop` → `memory-capture.mjs`: sends each finished turn to L0. Only the
  new part of the transcript each time (cursor in
  `~/.memory-tdai/claude-code/`).
- Both hooks always exit 0 and print nothing on failure — a down backend
  never blocks a session. Set `TDAI_DEBUG=1` to see what they do.

Same content, with comments: `agents/claude-code/settings.template.json`.

### 5c. MCP server (on-demand search/read/write from inside a session)

```bash
claude mcp add memorycore -s user --env TDAI_TEAM_ID=<team-id> --env TDAI_USER_ID=<user-id> -- \
  node <REPO>/agents/claude-code/mcp/server.mjs
```

Tools it exposes: `memory_search` (L0+L1), `scenario_list`/`scenario_read`
(L2), `core_read`/`core_write` (L3), `scenario_write`, `agent_list`.

The session is bound to its own project's agent, but the four read tools
(`memory_search`, `scenario_list`, `scenario_read`, `core_read`) accept an
optional `agent` argument (name like `sweetlips` or id `agt-...`, see
`agent_list`) to read another project's memory. Writes never take it — they
always go to the session's own agent.

### 5d. Rules that apply to both

**Do not set `TDAI_AGENT_ID`** in the hooks' env or the MCP registration —
leave it unset and the right agent is picked per project automatically: one
real MemoryCore agent per git repo (same repo across sessions/worktrees =
same agent), one shared `adhoc-chat` agent for chats outside any git repo.
The mapping is cached in `~/.memory-tdai/claude-code/agents.json`.
Registering a new agent needs the admin key (`TDAI_ADMIN_KEY_FILE`,
defaults to `deploy/global-images/.admin-key` in this repo).

**Changes only apply to new sessions.** Claude Code reads the `env` block
and connects MCP servers once at session start — an already-open session
keeps the old values until you start a new one.

Design reference (mapping, binding lifetime, cross-project reads): `docs/claude-code-memory-design.md`.

Full detail + why per-project, not per-session:
`agents/claude-code/README.md` "Memory isolation" section.

## Verifying it worked

- `curl http://127.0.0.1:8420/health` → `{"status":"ok",...}`
- Open the Panel, check **Agents 管理** — should show at least one agent.
- In a fresh Claude Code session inside a git repo, have a short exchange,
  then check MemoryCore captured it:
  `agents/claude-code/README.md` "Verified behaviour" table has the exact
  checks used to validate this originally.
