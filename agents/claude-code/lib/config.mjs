/**
 * Shared configuration for the Claude Code memory hooks and MCP server.
 *
 * Everything comes from the environment so no secret is ever written into a
 * settings file that might be committed. Missing values are NOT fatal: the
 * hooks degrade to no-ops rather than interrupting the user's session.
 */

import os from "node:os";
import path from "node:path";

/** Isolation triple + routing needed by every MemoryCore data-plane call. */
export function loadConfig() {
  const endpoint = (process.env.TDAI_ENDPOINT ?? "http://127.0.0.1:8420").replace(/\/+$/, "");

  return {
    endpoint,
    /** Instance id — `default` for a local single-instance deploy. */
    serviceId: process.env.TDAI_SERVICE_ID ?? "default",
    /** Layer-1 gateway token. Unset is fine when the gateway has no apiKey. */
    kernelToken: process.env.TDAI_KERNEL_TOKEN ?? "",
    /** v3 enforces the team+agent+user triple; absent values fall back to `default`. */
    teamId: process.env.TDAI_TEAM_ID ?? "default",
    agentId: process.env.TDAI_AGENT_ID ?? "default",
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
