# Antigravity integration - hooks + MCP (no proxy)

Same design as [`../claude-code`](../claude-code/README.md): Antigravity keeps its
own model connection; hooks move memory in and out, the MCP server serves
on-demand search. The hook logic and MemoryCore client are **reused from
`agents/claude-code/lib`**; only the payload / transcript parsing differs.

```
Antigravity ──SessionStart──▶ hooks/memory-recall.mjs  ─▶ MemoryCore (inject L3 + L2 index)
            ──Stop──────────▶ hooks/memory-capture.mjs ─▶ MemoryCore (append the turn to L0)
            ──MCP───────────▶ ../claude-code/mcp/server.mjs (memorycore: search / curate)
```

## Install

1. MCP: the `memorycore` server entry in `~/.gemini/config/mcp_config.json`
   (same `command: node`, `args: [.../agents/claude-code/mcp/server.mjs]`, and
   `env: TDAI_TEAM_ID / TDAI_USER_ID`).
2. Hooks: `node agents/antigravity/install.mjs` merges a `memory-hub` entry into
   `~/.gemini/config/hooks.json` (other hooks untouched; `--remove` undoes it).
   Start a new `agy` session afterwards.

## Differences from Claude Code

| | Claude Code | Antigravity |
|---|---|---|
| hook payload | snake_case: `session_id`, `cwd`, `transcript_path` | camelCase: `conversationId`, `workspacePaths[0]`, `transcriptPath` |
| recall output | `hookSpecificOutput.additionalContext` | `injectSteps: [{systemMessage: {systemMessage}}]` |
| transcript | `type: user/assistant`, uuid cursor | `USER_INPUT` / `PLANNER_RESPONSE`, `step_index` cursor |
| env | settings.json `env` | none - `lib/env.mjs` reads `TDAI_*` from the `memorycore` entry in `mcp_config.json` |
| cursors | `~/.memory-tdai/claude-code` | `~/.memory-tdai/antigravity` |
| memory block | one per session, bound to the repos of `cwd` | the same, per `conversationId`, for `workspacePaths[0]` |
| `mem: repo` command, printed binding | yes | no (no matching hook output) |

Memory blocks: see "Memory isolation" in [`../claude-code/README.md`](../claude-code/README.md).

Debug: set `TDAI_DEBUG=1`. Every hook exits 0 and prints valid JSON even when the
backend is down, so a session is never blocked.
