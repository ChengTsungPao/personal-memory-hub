/**
 * Shared configuration for the Claude Code memory hooks and MCP server.
 *
 * Everything comes from the environment so no secret is ever written into a
 * settings file that might be committed. Missing values are NOT fatal: the
 * hooks degrade to no-ops rather than interrupting the user's session.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Derive a stable agent_id from the project's git identity, so memory
 * naturally isolates per-project instead of every Claude Code session on the
 * machine sharing one bucket (see agents/claude-code/README.md "Memory
 * isolation: why agent_id, not session_id").
 *
 * Prefers the `origin` remote URL (stable across clones/worktrees). Falls
 * back to the repo's root commit hash — unlike the working-directory path,
 * this stays identical across `git worktree` checkouts of the same history,
 * which a path-based key would incorrectly split apart.
 *
 * When `cwd` isn't inside a git repo at all (a one-off chat with no project),
 * there's no stable project identity to accumulate memory around, so this
 * falls back to `sessionId` instead — each such chat gets its own bucket
 * rather than dumping into one shared catch-all with every other non-project
 * chat. That trades away cross-session memory for these specific chats (by
 * definition there's no "project" for it to persist across), which is the
 * right trade here: better than silently merging unrelated one-off
 * conversations into a shared bucket that then pollutes SessionStart context
 * for the next unrelated one-off chat. When `sessionId` also isn't available
 * (the MCP server has no per-call session id), falls back to "default".
 *
 * Must never throw or hang a hook — every git call is caught and bounded.
 */
function deriveAgentId(cwd, sessionId) {
  if (cwd) {
    const gitOpts = { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 };
    try {
      const remote = execFileSync("git", ["remote", "get-url", "origin"], gitOpts).toString().trim();
      if (remote) return `agt-${crypto.createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
    } catch {
      // no remote, or not a repo — fall through to the root-commit check below
    }
    try {
      const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], gitOpts)
        .toString().trim().split("\n")[0];
      if (rootCommit) return `agt-${rootCommit.slice(0, 16)}`;
    } catch {
      // not a git repo at all — fall through to the session-scoped fallback
    }
  }
  if (sessionId) return `agt-${sessionId}`;
  return null;
}

/**
 * Isolation triple + routing needed by every MemoryCore data-plane call.
 *
 * @param {string} [cwd] The session's working directory (hooks get this from
 *   the stdin payload; the MCP server, a long-lived process, uses its own
 *   process.cwd() by default). Used only to derive agent_id when
 *   TDAI_AGENT_ID isn't set explicitly.
 * @param {string} [sessionId] The session id (hooks get this from the stdin
 *   payload). Only used as a last-resort agent_id fallback when `cwd` isn't
 *   inside a git repo.
 */
export function loadConfig(cwd = process.cwd(), sessionId) {
  const endpoint = (process.env.TDAI_ENDPOINT ?? "http://127.0.0.1:8420").replace(/\/+$/, "");

  return {
    endpoint,
    /** Instance id — `default` for a local single-instance deploy. */
    serviceId: process.env.TDAI_SERVICE_ID ?? "default",
    /** Layer-1 gateway token. Unset is fine when the gateway has no apiKey. */
    kernelToken: process.env.TDAI_KERNEL_TOKEN ?? "",
    /** v3 enforces the team+agent+user triple; absent values fall back to `default`. */
    teamId: process.env.TDAI_TEAM_ID ?? "default",
    agentId: process.env.TDAI_AGENT_ID ?? deriveAgentId(cwd, sessionId) ?? "default",
    userId: process.env.TDAI_USER_ID ?? "default",
    /** Optional business dimension — omitted entirely when unset. */
    taskId: process.env.TDAI_TASK_ID ?? "",
    /** Per-request timeout. Hooks must never hang a turn. */
    timeoutMs: Number(process.env.TDAI_TIMEOUT_MS ?? 8000),
    /** Where capture cursors live. */
    stateDir: process.env.TDAI_STATE_DIR ?? path.join(os.homedir(), ".memory-tdai", "claude-code"),
    /** Set to "1" to log diagnostics to stderr (visible in hook debug output). */
    debug: process.env.TDAI_DEBUG === "1",
  };
}

/** The isolation fields, ready to spread into a request body. */
export function isolationFields(cfg) {
  const fields = {
    team_id: cfg.teamId,
    agent_id: cfg.agentId,
    user_id: cfg.userId,
  };
  if (cfg.taskId) fields.task_id = cfg.taskId;
  return fields;
}

export function debugLog(cfg, ...args) {
  if (cfg.debug) console.error("[tdai-hook]", ...args);
}
