// node --test agents/claude-code/lib/session.test.mjs
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindSession, editRepos, findRepos, repoAt } from "./session.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function makeRepo(dir, { commit = true } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (commit) {
    writeFileSync(path.join(dir, "a.txt"), dir);
    git(dir, "add", ".");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  }
  return dir;
}

const made = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ── repos ────────────────────────────────────────────────────────────────

test("finds the folder's repos one level down, skipping plain folders and repos with no commit", () => {
  const root = tmp();
  makeRepo(path.join(root, "a"));
  makeRepo(path.join(root, "b"), { commit: false });
  mkdirSync(path.join(root, "plain"));
  makeRepo(path.join(root, "plain", "deep")); // two levels down: not counted

  const repos = findRepos(root);
  assert.deepEqual(repos.map((r) => r.name), ["a"]);
  assert.match(repos[0].hash, /^[0-9a-f]{40}$/);
  rmSync(root, { recursive: true, force: true });
});

test("a subfolder and a worktree of a repo share its hash and name", () => {
  const root = tmp();
  const a = makeRepo(path.join(root, "a"));
  mkdirSync(path.join(a, "sub"));
  git(a, "worktree", "add", "-q", path.join(root, "wt"));

  assert.equal(repoAt(path.join(a, "sub")).hash, repoAt(a).hash);
  const wt = repoAt(path.join(root, "wt"));
  assert.equal(wt.hash, repoAt(a).hash);
  assert.equal(wt.name, "a");
  rmSync(root, { recursive: true, force: true });
});

// ── binding, against an in-memory MemoryCore ──────────────────────────────

let agents;
let bindings;
let seq;

function fakeMemoryCore() {
  agents = new Map();
  bindings = new Set(); // `${agent}|${asset}`
  seq = 0;
  globalThis.fetch = async (url, init) => {
    const route = new URL(url).pathname.replace("/v3/meta/", "");
    const body = JSON.parse(init.body);
    const ok = (data) => ({ ok: true, json: async () => ({ code: 0, data }) });
    switch (route) {
      case "agent/create": {
        const a = { agent_id: `agt-${++seq}`, name: body.name, status: "active", metadata_json: body.metadata_json, created_at: String(seq) };
        agents.set(a.agent_id, a);
        bindings.add(`${a.agent_id}|chat_memory-T-${a.agent_id}`);
        return ok(a);
      }
      case "agent/get":
        return agents.has(body.agent_id) ? ok(agents.get(body.agent_id)) : { ok: false, json: async () => ({ code: 404 }) };
      case "agent/update":
        Object.assign(agents.get(body.agent_id), {
          ...(body.metadata_json !== undefined ? { metadata_json: body.metadata_json } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
        });
        return ok(agents.get(body.agent_id));
      case "agent/list": {
        const items = [...agents.values()].filter((a) => a.status === "active");
        return ok({ items: items.slice(body.offset, body.offset + body.limit), total: items.length });
      }
      case "agent-fixed-asset/add":
        bindings.add(`${body.agent_id}|${body.binding.asset_id}`);
        return ok({});
      case "agent-fixed-asset/bindings-of-asset":
        return ok({
          items: [...bindings].filter((x) => x.endsWith(`|${body.asset_id}`)).map((x) => ({ agent_id: x.split("|")[0] })),
        });
      case "agent-fixed-asset/remove":
        bindings.delete(`${body.agent_id}|${body.asset_id}`);
        return ok({});
      default:
        throw new Error(`unexpected route ${route}`);
    }
  };
}

const boundTo = (sessionAgentId) =>
  [...bindings]
    .filter((b) => b.endsWith(`|chat_memory-T-${sessionAgentId}`))
    .map((b) => agents.get(b.split("|")[0]).name)
    .filter((n) => !n.includes("·"))
    .sort();
const repoTags = (sessionAgentId) => JSON.parse(agents.get(sessionAgentId).metadata_json).repos.map((r) => r.name);

let cfg;
beforeEach(() => {
  fakeMemoryCore();
  cfg = { endpoint: "http://core", serviceId: "default", adminKey: "k", teamId: "T", userId: "U", timeoutMs: 1000, stateDir: tmp() };
});

test("a folder with no repo goes to New-chat, and moves to its repos once one appears", async () => {
  const root = tmp();
  const first = await bindSession(cfg, "sess-1", root);
  assert.deepEqual(boundTo(first.sessionAgentId), ["New-chat"]);

  makeRepo(path.join(root, "a"));
  makeRepo(path.join(root, "b"));
  const second = await bindSession(cfg, "sess-1", root);
  assert.equal(second.sessionAgentId, first.sessionAgentId, "one block per session");
  assert.deepEqual(boundTo(second.sessionAgentId), ["a", "b"]);
  assert.deepEqual(repoTags(second.sessionAgentId).sort(), ["a", "b"]);
  rmSync(root, { recursive: true, force: true });
});

test("the session finds its block from the server even without the local cache", async () => {
  const root = tmp();
  const first = await bindSession(cfg, "sess-2", root);
  const again = await bindSession({ ...cfg, stateDir: tmp() }, "sess-2", root);
  assert.equal(again.sessionAgentId, first.sessionAgentId);
  assert.equal([...agents.values()].filter((a) => a.name.endsWith("· sess-2")).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("two sessions in the same repo share its repo agent", async () => {
  const root = tmp();
  const a = makeRepo(path.join(root, "a"));
  const s1 = await bindSession(cfg, "sess-3", a);
  const s2 = await bindSession(cfg, "sess-4", a);
  assert.notEqual(s1.sessionAgentId, s2.sessionAgentId);
  assert.equal(s1.targets[0].agent_id, s2.targets[0].agent_id);
  rmSync(root, { recursive: true, force: true });
});

test("mem: repo rm keeps a repo out after the next scan, and add brings it back", async () => {
  const root = tmp();
  makeRepo(path.join(root, "a"));
  makeRepo(path.join(root, "b"));
  const { sessionAgentId } = await bindSession(cfg, "sess-5", root);

  await editRepos(cfg, "sess-5", root, "rm", "b");
  await bindSession(cfg, "sess-5", root);
  assert.deepEqual(boundTo(sessionAgentId), ["a"]);

  await editRepos(cfg, "sess-5", root, "add", "b");
  assert.deepEqual(boundTo(sessionAgentId), ["a", "b"]);

  const other = makeRepo(path.join(tmp(), "elsewhere"));
  await editRepos(cfg, "sess-5", root, "add", other);
  assert.deepEqual(boundTo(sessionAgentId), ["a", "b", "elsewhere"]);
  await assert.rejects(editRepos(cfg, "sess-5", root, "rm", "nope"), /沒有綁定/);
  rmSync(root, { recursive: true, force: true });
});

test("mem: repo rm by hash needs 7+ characters, so a short name never matches a hash", async () => {
  const root = tmp();
  const a = repoAt(makeRepo(path.join(root, "a")));
  const { sessionAgentId } = await bindSession(cfg, "sess-6", root);

  await assert.rejects(editRepos(cfg, "sess-6", root, "rm", a.hash.slice(0, 1)), /沒有綁定/);
  assert.deepEqual(boundTo(sessionAgentId), ["a"]);
  await editRepos(cfg, "sess-6", root, "rm", a.hash.slice(0, 7));
  assert.deepEqual(boundTo(sessionAgentId), ["New-chat"]);
});

test("bindings come from the server: a lost cache still drops a stale repo, and other agents stay", async () => {
  const root = tmp();
  const a = makeRepo(path.join(root, "a"));
  const b = makeRepo(path.join(root, "b"));
  const s = await bindSession(cfg, "sess-7", a);
  assert.deepEqual(boundTo(s.sessionAgentId), ["a"]);

  // Bound by hand to some other agent in the panel: not ours to remove.
  const other = await (await fetch("http://core/v3/meta/agent/create", { method: "POST", body: JSON.stringify({ name: "hand-picked" }) })).json();
  bindings.add(`${other.data.agent_id}|chat_memory-T-${s.sessionAgentId}`);

  // Same session id seen from repo b, with the local cache gone.
  await bindSession({ ...cfg, stateDir: tmp() }, "sess-7", b);
  assert.deepEqual(boundTo(s.sessionAgentId), ["b", "hand-picked"]);
});

test("manual edits are kept on the server with the block", async () => {
  const root = tmp();
  makeRepo(path.join(root, "a"));
  makeRepo(path.join(root, "b"));
  const { sessionAgentId } = await bindSession(cfg, "sess-8", root);
  await editRepos(cfg, "sess-8", root, "rm", "b");

  const m = JSON.parse(agents.get(sessionAgentId).metadata_json);
  assert.equal(m.removed.length, 1);
  await bindSession({ ...cfg, stateDir: tmp() }, "sess-8", root); // another machine / lost cache
  assert.deepEqual(boundTo(sessionAgentId), ["a"]);
});

test("a block is named after its repos and renamed when they change", async () => {
  const root = tmp();
  const { sessionAgentId } = await bindSession(cfg, "sess-9abcdef", root);
  assert.equal(agents.get(sessionAgentId).name, "New-chat · sess-9ab");
  makeRepo(path.join(root, "a"));
  makeRepo(path.join(root, "b"));
  await bindSession(cfg, "sess-9abcdef", root);
  assert.equal(agents.get(sessionAgentId).name, "a + b · sess-9ab");
});

test("the New-chat agent made before session blocks is adopted, not duplicated", async () => {
  const legacy = await (await fetch("http://core/v3/meta/agent/create", { method: "POST", body: JSON.stringify({ name: "New-chat" }) })).json();
  const { targets } = await bindSession(cfg, "sess-10", tmp());
  assert.equal(targets[0].agent_id, legacy.data.agent_id);
  assert.equal(JSON.parse(agents.get(legacy.data.agent_id).metadata_json).kind, "new-chat");
  assert.equal([...agents.values()].filter((a) => a.name === "New-chat").length, 1);
});
