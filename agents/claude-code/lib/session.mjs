/**
 * Session memory blocks.
 *
 * Every Claude Code session writes to its own memory block: a hidden *session agent* in MemoryCore
 * (metadata `{"kind":"session","session_id":…}`) whose chat_memory is that block. The block is
 * bound to the *repo agents* the session belongs to, so it shows up under each of them:
 *
 *   - a repo is identified by its root commit hash only (one repo = one hash; worktrees and other
 *     clones of it share the hash);
 *   - the session belongs to the repo its folder is in, plus the repos one level below the folder;
 *   - with no repo it belongs to New-chat, and leaves New-chat once a repo appears;
 *   - `mem: repo add|rm` adds or removes a repo by hand; a removed repo is never added back
 *     automatically.
 *
 * The session id → block mapping lives on the server (the session agent's metadata), so a session
 * always finds its block again; the local state file is only a cache plus the manual edits.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { CoreClient } from "./core-client.mjs";

export const NEW_CHAT_NAME = "New-chat";

// ============================
// Repos
// ============================

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * The repo `dir` is in, as `{ hash, name, dir }`, or null when it is not in a repo or the repo has
 * no commit yet. `hash` is the root commit (the first in sort order when the history has several);
 * `name` is the main repo folder's name, not a worktree's.
 */
export function repoAt(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const roots = git(top, ["rev-list", "--max-parents=0", "HEAD"]).split(/\r?\n/).filter(Boolean).sort();
  if (roots.length === 0) return null;
  const common = git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const name = path.basename(common ? path.dirname(common) : top) || path.basename(top);
  return { hash: roots[0], name, dir: top };
}

/** The repos a session folder belongs to: the one it is in, plus repos one level down. */
export function findRepos(cwd) {
  const found = new Map();
  const add = (repo) => {
    if (repo && !found.has(repo.hash)) found.set(repo.hash, repo);
  };
  if (!cwd) return [];
  add(repoAt(cwd));
  let entries = [];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    // unreadable folder: only the repo it is in
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    const child = path.join(cwd, entry.name);
    // Only repo roots: a plain subfolder of the cwd's own repo has no .git of its own.
    if (existsSync(path.join(child, ".git"))) add(repoAt(child));
  }
  return [...found.values()];
}

// ============================
// Local state: cache + manual edits
// ============================

function statePath(cfg, sessionId) {
  return path.join(cfg.stateDir, "sessions", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

export function readState(cfg, sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(cfg, sessionId), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(cfg, sessionId, state) {
  const file = statePath(cfg, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

// ============================
// MemoryCore control plane (admin user key)
// ============================

export async function meta(cfg, route, body) {
  const res = await fetch(`${cfg.endpoint}/v3/meta/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": cfg.serviceId,
      "x-tdai-user-key": cfg.adminKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.code !== 0) throw new Error(`meta/${route}: ${payload.message ?? res.status}`);
  return payload.data;
}

export function parseMeta(agent) {
  try {
    return JSON.parse(agent?.metadata_json || "{}") ?? {};
  } catch {
    return {};
  }
}

/** All active agents of the team, paged through. */
export async function listTeamAgents(cfg) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const data = await meta(cfg, "agent/list", { team_id: cfg.teamId, status: "active", limit: 100, offset });
    items.push(...(data?.items ?? []));
    if (!data?.items?.length || items.length >= (data.total ?? 0)) return items;
  }
}

export const blockAssetId = (cfg, agentId) => `chat_memory-${cfg.teamId}-${agentId}`;

/** An active agent by id, or null (deleted, archived, or not found). */
async function activeAgent(cfg, agentId) {
  if (!agentId) return null;
  try {
    const agent = await meta(cfg, "agent/get", { agent_id: agentId });
    return agent?.status === "active" ? agent : null;
  } catch {
    return null;
  }
}

/**
 * Find an agent by its metadata, creating it when none matches. `cacheId` is tried first so the
 * common case costs one agent/get instead of listing the team.
 */
async function findOrCreate(cfg, { cacheId, match, name, metadata, listAgents }) {
  const cached = await activeAgent(cfg, cacheId);
  if (cached && match(parseMeta(cached))) return cached;
  const found = (await listAgents()).find((a) => match(parseMeta(a)));
  if (found) return found;
  return meta(cfg, "agent/create", {
    team_id: cfg.teamId,
    owner_user_id: cfg.userId,
    name,
    metadata_json: JSON.stringify(metadata),
  });
}

// ============================
// Binding
// ============================

function sessionName(cwd, sessionId) {
  return `${path.basename(cwd || "") || "session"} · ${sessionId.slice(0, 8)}`;
}

/**
 * Make sure this session has its block and that the block is bound to the right agents. Returns
 * `{ sessionAgentId, repos, targets }`: the repos the block is tagged with and the agents it is
 * bound to (`[{ agent_id, name }]`). Writes the state cache.
 */
export async function bindSession(cfg, sessionId, cwd) {
  const state = readState(cfg, sessionId);
  state.added ??= [];
  state.removed ??= [];
  state.repoAgents ??= {};

  // Listed at most once per call, and only when a cached id misses.
  let listed;
  const listAgents = async () => (listed ??= await listTeamAgents(cfg));

  const session = await findOrCreate(cfg, {
    cacheId: state.sessionAgentId,
    match: (m) => m.kind === "session" && m.session_id === sessionId,
    name: sessionName(cwd, sessionId),
    metadata: { kind: "session", session_id: sessionId, cwd: cwd ?? "", repos: [] },
    listAgents,
  });
  state.sessionAgentId = session.agent_id;

  // Repos: found in the folder, plus manual adds, minus manual removals.
  const repos = new Map();
  for (const r of findRepos(cwd)) repos.set(r.hash, { hash: r.hash, name: r.name });
  for (const r of state.added) repos.set(r.hash, r);
  for (const hash of state.removed) repos.delete(hash);

  const targets = [];
  for (const repo of repos.values()) {
    const agent = await findOrCreate(cfg, {
      cacheId: state.repoAgents[repo.hash],
      match: (m) => m.kind === "repo" && m.root_commit === repo.hash,
      name: repo.name,
      metadata: { kind: "repo", root_commit: repo.hash },
      listAgents,
    });
    state.repoAgents[repo.hash] = agent.agent_id;
    targets.push({ agent_id: agent.agent_id, name: agent.name });
  }
  if (targets.length === 0) {
    const newChat = await findOrCreate(cfg, {
      cacheId: state.newChatId,
      match: (m) => m.kind === "new-chat",
      name: NEW_CHAT_NAME,
      metadata: { kind: "new-chat" },
      listAgents,
    });
    state.newChatId = newChat.agent_id;
    targets.push({ agent_id: newChat.agent_id, name: newChat.name });
  }

  // Apply the difference against what is bound now.
  const assetId = blockAssetId(cfg, session.agent_id);
  const bound = new Set(state.bound ?? []);
  const wanted = new Set(targets.map((t) => t.agent_id));
  for (const agentId of wanted) {
    if (bound.has(agentId)) continue;
    await meta(cfg, "agent-fixed-asset/add", {
      agent_id: agentId,
      binding: { asset_id: assetId, asset_type: "chat_memory", created_by: cfg.userId },
    });
  }
  for (const agentId of bound) {
    if (!wanted.has(agentId)) await meta(cfg, "agent-fixed-asset/remove", { agent_id: agentId, asset_id: assetId });
  }
  state.bound = [...wanted];

  // Tag the block with its repos, so the panel can show them.
  const tags = [...repos.values()];
  const sessionMeta = parseMeta(session);
  if (JSON.stringify(sessionMeta.repos ?? []) !== JSON.stringify(tags)) {
    await meta(cfg, "agent/update", {
      agent_id: session.agent_id,
      metadata_json: JSON.stringify({ ...sessionMeta, repos: tags }),
    });
  }

  writeState(cfg, sessionId, state);
  return { sessionId, sessionAgentId: session.agent_id, repos: tags, targets };
}

/**
 * Prepare a hook call: load the config and, unless TDAI_AGENT_ID pins one agent, bind this
 * session's memory block and point `cfg.agentId` at it. `binding` is null in the pinned mode;
 * `skip` is set when the block cannot be made (no admin key) and nothing should be written.
 */
export async function openSession(sessionId, cwd) {
  if (process.env.TDAI_AGENT_ID) return { cfg: await loadConfig(cwd), binding: null };
  const cfg = await loadConfig(cwd, { projectAgent: false });
  if (!cfg.adminKey || !sessionId) return { cfg, binding: null, skip: true };
  const binding = await bindSession(cfg, sessionId, cwd);
  cfg.agentId = binding.sessionAgentId;
  return { cfg, binding };
}

// ============================
// Reading across blocks
// ============================

/** The memory blocks bound to the given agents, newest first, as `[{ agentId, name }]`. */
export async function blocksOf(cfg, agentIds, { exclude = [] } = {}) {
  const prefix = `chat_memory-${cfg.teamId}-`;
  const seen = new Set([...exclude, ...agentIds]);
  const blocks = [];
  for (const agentId of agentIds) {
    const data = await meta(cfg, "agent-fixed-asset/list-with-detail", {
      agent_id: agentId,
      asset_types: ["chat_memory"],
      limit: 100,
    }).catch(() => null);
    for (const item of data?.items ?? []) {
      if (!item.asset_id?.startsWith(prefix)) continue;
      const owner = item.asset_id.slice(prefix.length);
      if (seen.has(owner)) continue;
      seen.add(owner);
      blocks.push({ agentId: owner, name: item.name, createdAt: item.created_at ?? "" });
    }
  }
  return blocks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The repo agents for a folder, looked up only (never created). */
export async function repoAgentsFor(cfg, cwd) {
  const hashes = new Set(findRepos(cwd).map((r) => r.hash));
  if (hashes.size === 0) return [];
  const agents = await listTeamAgents(cfg);
  return agents.filter((a) => {
    const m = parseMeta(a);
    return m.kind === "repo" && hashes.has(m.root_commit);
  });
}

/**
 * L3 and the L2 index to load at session start: from the other blocks under the repo agents this
 * session is bound to (New-chat sessions do not read each other's memory). Each scenario entry
 * carries `agent`, the block to pass to `scenario_read`.
 */
export async function recallMemory(cfg, binding, { maxBlocks = 10 } = {}) {
  const client = new CoreClient(cfg);
  if (!binding) {
    const [core, scenarios] = await Promise.allSettled([client.readCore(), client.listScenarios()]);
    return {
      core: core.status === "fulfilled" ? core.value?.content ?? null : null,
      scenarios: scenarios.status === "fulfilled" ? scenarios.value?.entries ?? [] : [],
    };
  }
  if (binding.repos.length === 0) return { core: null, scenarios: [] };
  const blocks = (
    await blocksOf(cfg, binding.targets.map((t) => t.agent_id), { exclude: [binding.sessionAgentId] })
  ).slice(0, maxBlocks);
  const results = await Promise.all(
    blocks.map(async (b) => {
      const [core, scenarios] = await Promise.allSettled([
        client.readCore(b.agentId),
        client.listScenarios(undefined, b.agentId),
      ]);
      return { block: b, core: core.value?.content, scenarios: scenarios.value?.entries ?? [] };
    }),
  );
  const cores = results.filter((r) => r.core).map((r) => `#### ${r.block.name}\n\n${r.core}`);
  return {
    core: cores.length ? cores.join("\n\n") : null,
    scenarios: results.flatMap((r) => r.scenarios.map((e) => ({ ...e, agent: r.block.agentId }))),
  };
}

/**
 * `mem: repo add <path or name>` / `mem: repo rm <name or hash>`: edit this session's repos by
 * hand. A removed repo stays removed even when the folder scan finds it again. Returns the new
 * binding, or throws with a message for the user.
 */
export async function editRepos(cfg, sessionId, cwd, op, ref) {
  const state = readState(cfg, sessionId);
  state.added ??= [];
  state.removed ??= [];
  ref = (ref ?? "").trim();
  if (!ref) throw new Error(`用法：mem: repo ${op} <${op === "add" ? "路徑或 repo 名稱" : "repo 名稱或 hash"}>`);

  let repo;
  if (op === "add") {
    repo = repoAt(path.resolve(cwd || ".", ref));
    if (!repo) {
      const agent = (await listTeamAgents(cfg)).find((a) => parseMeta(a).kind === "repo" && a.name === ref);
      if (agent) repo = { hash: parseMeta(agent).root_commit, name: agent.name };
    }
    if (!repo) throw new Error(`找不到 repo「${ref}」：給一個 repo 的路徑，或已經有記憶的 repo 名稱`);
    state.added = [...state.added.filter((r) => r.hash !== repo.hash), { hash: repo.hash, name: repo.name }];
    state.removed = state.removed.filter((h) => h !== repo.hash);
  } else {
    const known = [...findRepos(cwd), ...state.added];
    repo = known.find((r) => r.name === ref || r.hash.startsWith(ref));
    if (!repo) throw new Error(`這個 session 沒有綁定 repo「${ref}」`);
    state.added = state.added.filter((r) => r.hash !== repo.hash);
    if (!state.removed.includes(repo.hash)) state.removed.push(repo.hash);
  }
  writeState(cfg, sessionId, state);
  return bindSession(cfg, sessionId, cwd);
}

/** The line printed after each hook: this session's block and the repos it belongs to. */
export function describeBinding({ sessionId, repos, targets }) {
  const block = `🧠 記憶塊 ${sessionId.slice(0, 8)}`;
  if (repos.length === 0) return `${block} → ${NEW_CHAT_NAME}（沒有 repo）`;
  return `${block} → ${targets.map((t, i) => `${t.name} (${repos[i]?.hash.slice(0, 7) ?? "?"})`).join(" · ")}`;
}
