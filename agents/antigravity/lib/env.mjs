/**
 * Environment bootstrap for the Antigravity hooks. Import this BEFORE
 * ../../claude-code/lib/config.mjs.
 *
 * Antigravity's hooks.json has no `env` block (Claude Code's settings.json
 * does), so TDAI_* routing would otherwise fall back to `default`. The
 * `memorycore` MCP server entry in mcp_config.json already carries the same
 * non-secret identity (TDAI_TEAM_ID / TDAI_USER_ID ...), so reuse it as the
 * single source of truth. Anything already set in the real environment wins.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configRoot = process.env.AGY_CONFIG_HOME ?? path.join(os.homedir(), ".gemini", "config");

try {
  const raw = fs.readFileSync(path.join(configRoot, "mcp_config.json"), "utf8").replace(/^\uFEFF/, "");
  const env = JSON.parse(raw)?.mcpServers?.memorycore?.env ?? {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("TDAI_") && process.env[k] === undefined) process.env[k] = String(v);
  }
} catch {
  // No mcp_config.json / no memorycore entry: fall back to config.mjs defaults.
}

// Keep Antigravity's capture cursors apart from Claude Code's.
process.env.TDAI_STATE_DIR ??= path.join(os.homedir(), ".memory-tdai", "antigravity");
