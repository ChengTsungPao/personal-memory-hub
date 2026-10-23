#!/usr/bin/env node
/**
 * Registers the Personal Memory Hub hooks and MCP server in Antigravity's
 * global config (~/.gemini/config/, or $AGY_CONFIG_HOME). Idempotent: only the
 * `memory-hub` hook and `memorycore` MCP server are touched; other entries are
 * left alone.
 *
 *   node agents/antigravity/install.mjs            # install hooks + MCP
 *   node agents/antigravity/install.mjs --remove   # remove hooks
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const configRoot = process.env.AGY_CONFIG_HOME ?? path.join(os.homedir(), ".gemini", "config");
const hooksFile = path.join(configRoot, "hooks.json");
const mcpFile = path.join(configRoot, "mcp_config.json");
const HOOK_NAME = "memory-hub";
const remove = process.argv.includes("--remove");

const readJson = (p) => {
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim() || "{}");
};

fs.mkdirSync(configRoot, { recursive: true });

const hooks = readJson(hooksFile);
if (remove) {
  delete hooks[HOOK_NAME];
} else {
  const cmd = (script) => `node "${path.join(here, "hooks", script).replaceAll("\\", "/")}"`;
  hooks[HOOK_NAME] = {
    SessionStart: [{ type: "command", command: cmd("memory-recall.mjs"), timeout: 10 }],
    Stop: [{ type: "command", command: cmd("memory-capture.mjs"), timeout: 45 }],
  };
}
fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
console.log(`${remove ? "removed" : "installed"} '${HOOK_NAME}' in ${hooksFile}`);

if (!remove) {
  const mcp = readJson(mcpFile);
  const servers = (mcp.mcpServers ??= {});
  const existingEnv = servers.memorycore?.env ?? {};
  let claudeEnv = {};
  try {
    claudeEnv = readJson(path.join(os.homedir(), ".claude.json"))?.mcpServers?.memorycore?.env ?? {};
  } catch {
    // ignore
  }
  const env = { ...claudeEnv, ...existingEnv };
  for (const k of ["TDAI_ENDPOINT", "TDAI_SERVICE_ID", "TDAI_TEAM_ID", "TDAI_USER_ID"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const serverMjs = path.resolve(here, "..", "claude-code", "mcp", "server.mjs").replaceAll("\\", "/");
  servers.memorycore = { command: "node", args: [serverMjs], ...(Object.keys(env).length ? { env } : {}) };
  fs.writeFileSync(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  console.log(`installed 'memorycore' MCP in ${mcpFile}`);
}
