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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

/** Sentinel project key for every chat that isn't inside a git repo. */
const ADHOC_KEY = "adhoc";
const ADHOC_NAME = "adhoc-chat";

/**
 * Derive a stable *project key* + human-readable name from `cwd`'s git
 * identity, so memory naturally isolates per-project instead of every
 * Claude Code session on the machine sharing one bucket (see
 * agents/claude-code/README.md "Memory isolation: why agent_id is
 * per-project, not per-session").
 *
 * This is NOT the final agent_id — MemoryCore's `/v3/meta/agent/create`
 * doesn't accept a caller-chosen id, it always mints its own random one. So
 * `resolveAgentId()` below uses this key to look up (or register, once) the
 * real agent_id in a local registry file instead.
 *
 * Prefers the `origin` remote URL (stable across clones/worktrees). Falls
 * back to the repo's root commit hash — unlike the working-directory path,
 * this stays identical across `git worktree` checkouts of the same history,
 * which a path-based key would incorrectly split apart.
 *
 * When `cwd` isn't inside a git repo at all (a one-off chat with no
 * project), there's no stable project identity to accumulate memory
 * around — these all share one fixed "adhoc-chat" bucket (ADHOC_KEY) rather
 * than each getting their own (that was tried first; it meant every
 * non-project chat minted a brand-new agent that would show up in the
 * Panel forever after a single use).
 *
 * Must never throw or hang a hook — every git call is caught and bounded.
 */
function deriveProjectKey(cwd) {
  if (cwd) {
    const gitOpts = { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 };
    try {
      const remote = execFileSync("git", ["remote", "get-url", "origin"], gitOpts).toString().trim();
      if (remote) {
        const key = `git-remote:${crypto.createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
        const name = remote.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() || key;
        return { key, name };
      }
    } catch {
      // no remote, or not a repo — fall through to the root-commit check below
    }
    try {
      const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], gitOpts)
        .toString().trim().split("\n")[0];
      if (rootCommit) {
        const key = `git-root:${rootCommit.slice(0, 16)}`;
        const name = path.basename(cwd) || key;
        return { key, name };
      }
    } catch {
      // not a git repo at all — fall through to the adhoc bucket below
    }
  }
  return { key: ADHOC_KEY, name: ADHOC_NAME };
}

// ============================
// Local project -> agent_id registry
// ============================

/** Lives with the database (not with machine-local cursors) so it moves with the data to a new machine. */
const HUB_DIR = path.join(os.homedir(), ".personal-memory-hub");
const REGISTRY_FILE = process.env.TDAI_REGISTRY_FILE ?? path.join(HUB_DIR, "agents.json");

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf8");
}

/**
 * Resolve a project key to a real MemoryCore agent_id, registering a new
 * agent (which auto-provisions its chat_memory asset) the first time this
 * project key is seen. Cached in `~/.personal-memory-hub/agents.json` after that.
 *
 * MemoryCore's HTTP API needs the admin `x-tdai-user-key` (not the plain
 * `Bearer local` the hooks otherwise use) to call `/v3/meta/agent/create` —
 * see agents/claude-code/README.md. Returns null (caller falls back to
 * "default") on any failure: missing admin key file, network error, auth
 * error — registration is a nice-to-have, never worth blocking a hook over.
 */
async function resolveAgentId(cfg, projectKey, projectName) {
  const registry = loadRegistry();
  if (registry[projectKey]) return registry[projectKey];

  if (!cfg.adminKey) return null;

  try {
    const res = await fetch(`${cfg.endpoint}/v3/meta/agent/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": cfg.serviceId,
        "x-tdai-user-key": cfg.adminKey,
      },
      body: JSON.stringify({ team_id: cfg.teamId, owner_user_id: cfg.userId, name: projectName }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const payload = await res.json();
    if (!res.ok || payload.code !== 0 || !payload.data?.agent_id) return null;

    registry[projectKey] = payload.data.agent_id;
    saveRegistry(registry);
    return payload.data.agent_id;
  } catch {
    return null;
  }
}

/**
 * Isolation triple + routing needed by every MemoryCore data-plane call.
 *
 * @param {string} [cwd] The session's working directory (hooks get this from
 *   the stdin payload; the MCP server, a long-lived process, uses its own
 *   process.cwd() by default). Used only to derive agent_id when
 *   TDAI_AGENT_ID isn't set explicitly.
 */
export async function loadConfig(cwd = process.cwd()) {
  const endpoint = (process.env.TDAI_ENDPOINT ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
  const stateDir = process.env.TDAI_STATE_DIR ?? path.join(os.homedir(), ".memory-tdai", "claude-code");
  const adminKeyFile = process.env.TDAI_ADMIN_KEY_FILE ?? path.join(HUB_DIR, "admin-key");

  const cfg = {
    endpoint,
    /** Instance id — `default` for a local single-instance deploy. */
    serviceId: process.env.TDAI_SERVICE_ID ?? "default",
    /** Layer-1 gateway token. Unset is fine when the gateway has no apiKey. */
    kernelToken: process.env.TDAI_KERNEL_TOKEN ?? "",
    /** v3 enforces the team+agent+user triple; absent values fall back to `default`. */
    teamId: process.env.TDAI_TEAM_ID ?? "default",
    userId: process.env.TDAI_USER_ID ?? "default",
    /** Optional business dimension — omitted entirely when unset. */
    taskId: process.env.TDAI_TASK_ID ?? "",
    /** Per-request timeout. Hooks must never hang a turn. */
    timeoutMs: Number(process.env.TDAI_TIMEOUT_MS ?? 8000),
    /** Where machine-local capture cursors live (the agent registry is in HUB_DIR). */
    stateDir,
    /** Admin user_key, only used to auto-register a new agent per project. */
    adminKey: existsSync(adminKeyFile) ? readFileSync(adminKeyFile, "utf8").trim() : "",
    /** Set to "1" to log diagnostics to stderr (visible in hook debug output). */
    debug: process.env.TDAI_DEBUG === "1",
  };

  if (process.env.TDAI_AGENT_ID) {
    cfg.agentId = process.env.TDAI_AGENT_ID;
  } else {
    const { key, name } = deriveProjectKey(cwd);
    cfg.agentId = (await resolveAgentId(cfg, key, name)) ?? "default";
  }

  return cfg;
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
