/**
 * Token sanitization & secret scanner for backup staging (Design Doc §5).
 *
 * Principles:
 *   - Keep Memory Hub internal keys (`admin-key`, `meta_user_keys.key_value`,
 *     `.env` `MEMORY_CORE_GATEWAY_API_KEY` & `KNOWLEDGE_SERVICE_KEY`).
 *   - Strip personal and third-party tokens (`MEMORY_LLM_API_KEY`, `MEMORY_EMBEDDING_API_KEY`,
 *     `OPENROUTER_API_KEY`, `PROXY_UPSTREAM_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
 *     `tdai-gateway.yaml` `llm.apiKey` / `embedding.apiKey`,
 *     llm-gateway `.env` `API_KEY` & `config.json` `server.api_key`,
 *     `knowledge.db` `knowledge_connector.token` & `llm_binding.api_key`,
 *     `metadata.db` `meta_instance_upstream_config.api_key` & `meta_users.password`,
 *     Google OAuth refresh_token / client_secret).
 *   - Scan all config files and database config tables in the staging snapshot before packing;
 *     if any unstripped secret is detected, abort the backup immediately.
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** Env keys whose values must be stripped to empty string in `.env` files */
export const ENV_KEYS_TO_STRIP = new Set([
  "MEMORY_LLM_API_KEY",
  "MEMORY_EMBEDDING_API_KEY",
  "OPENROUTER_API_KEY",
  "PROXY_UPSTREAM_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "API_KEY",
]);

/** Env keys that are internal to Memory Hub and allowed to keep their values */
export const ENV_KEYS_WHITELIST = new Set([
  "MEMORY_CORE_GATEWAY_API_KEY",
  "KNOWLEDGE_SERVICE_KEY",
  "KNOWLEDGE_AUTH_TOKEN",
]);

/**
 * Strip secret values in a `.env` file content while preserving variable names, comments, and layout.
 */
export function sanitizeEnvContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
      if (!m) return line;
      const [, prefix, key, eq] = m;
      if (ENV_KEYS_WHITELIST.has(key!)) return line;
      if (
        ENV_KEYS_TO_STRIP.has(key!) ||
        /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(key!)
      ) {
        return `${prefix}${key}${eq}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Strip `apiKey:` values under `llm:` / `embedding:` (or any `apiKey:` / `api_key:` line)
 * in `tdai-gateway.yaml`.
 */
export function sanitizeGatewayYamlContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:apiKey|api_key)\s*:\s*)(.+)$/);
      if (!m) return line;
      return `${m[1]}""`;
    })
    .join("\n");
}

/**
 * Strip `server.api_key` (and any top-level/nested `api_key`, `apiKey`, `secret`, `token` fields)
 * in `llm-gateway/config.json`.
 */
export function sanitizeJsonConfigContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    const scrub = (obj: unknown): unknown => {
      if (Array.isArray(obj)) return obj.map(scrub);
      if (obj && typeof obj === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (/^(api_key|apiKey|token|secret|client_secret|refresh_token|password)$/i.test(k) && typeof v === "string") {
            out[k] = "";
          } else {
            out[k] = scrub(v);
          }
        }
        return out;
      }
      return obj;
    };
    return `${JSON.stringify(scrub(parsed), null, 2)}\n`;
  } catch {
    return content;
  }
}

/**
 * Sanitize a snapshot copy of `metadata.db` (never call on the live DB).
 * Also verifies `PRAGMA integrity_check`.
 */
export function sanitizeAndCheckMetadataDb(dbPath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => String(r.name)),
    );
    if (tables.has("meta_instance_upstream_config")) {
      db.exec("UPDATE meta_instance_upstream_config SET api_key = ''");
    }
    if (tables.has("meta_users")) {
      db.exec("UPDATE meta_users SET password = NULL");
    }
    if (tables.has("meta_config_params")) {
      // Remove Google OAuth refresh token & client_secret from backup snapshot
      db.exec(`
        UPDATE meta_config_params
        SET param_value = ''
        WHERE module = 'backup' AND param_name IN ('drive_refresh_token', 'drive_client_secret')
      `);
    }
    db.exec("VACUUM");
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== "ok") {
      throw new Error(`metadata.db integrity_check failed: ${JSON.stringify(row)}`);
    }
  } finally {
    db.close();
  }
}

/**
 * Verify `PRAGMA integrity_check` on a snapshot SQLite file (e.g. `vectors.db`).
 */
export function verifySqliteIntegrity(dbPath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== "ok") {
      throw new Error(`${path.basename(dbPath)} integrity_check failed: ${JSON.stringify(row)}`);
    }
  } finally {
    db.close();
  }
}

export interface SecretScanFinding {
  location: string;
  reason: string;
}

const SECRET_VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // sk-... (OpenAI, Anthropic sk-ant-..., OpenRouter sk-or-..., DeepSeek, etc.) excluding Memory Hub's own sk-mem-
  { name: "sk-* API key", re: /\bsk-(?!mem-)[A-Za-z0-9_-]{12,}\b/ },
  // Notion tokens
  { name: "Notion token (ntn_/secret_)", re: /\b(?:ntn_[A-Za-z0-9]{16,}|secret_[A-Za-z0-9]{20,})\b/ },
  // Google API key / OAuth token
  { name: "Google API/OAuth token", re: /\b(?:AIza[0-9A-Za-z_-]{25,}|ya29\.[0-9A-Za-z_-]{20,}|1\/\/[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{16,})\b/ },
  // GitHub PAT
  { name: "GitHub token", re: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
];

function scanTextForSecrets(text: string, location: string, findings: SecretScanFinding[]): void {
  for (const pat of SECRET_VALUE_PATTERNS) {
    if (pat.re.test(text)) {
      findings.push({ location, reason: `Matched ${pat.name}` });
    }
  }
}

function scanEnvFile(filePath: string, relLabel: string, findings: SecretScanFinding[]): void {
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const rawVal = m[2]!.trim().replace(/^['"]|['"]$/g, "");
    if (!rawVal || rawVal === "ollama" || rawVal === "REPLACE_ME") continue;
    if (ENV_KEYS_WHITELIST.has(key)) continue;
    if (ENV_KEYS_TO_STRIP.has(key) || /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(key)) {
      findings.push({
        location: `${relLabel}:${key}`,
        reason: `Unstripped secret in env variable ${key}`,
      });
      continue;
    }
    scanTextForSecrets(rawVal, `${relLabel}:${key}`, findings);
  }
}

function scanSqliteConfigTables(dbPath: string, relLabel: string, findings: SecretScanFinding[]): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => String(r.name)),
    );

    if (tables.has("knowledge_connector")) {
      const rows = db
        .prepare("SELECT token FROM knowledge_connector WHERE token IS NOT NULL AND token != ''")
        .all() as Array<{ token: string }>;
      for (let i = 0; i < rows.length; i++) {
        findings.push({
          location: `${relLabel}:knowledge_connector[${i}].token`,
          reason: "Unstripped connector token",
        });
      }
    }

    if (tables.has("llm_binding")) {
      const rows = db
        .prepare("SELECT api_key FROM llm_binding WHERE api_key IS NOT NULL AND api_key != ''")
        .all() as Array<{ api_key: string }>;
      for (let i = 0; i < rows.length; i++) {
        findings.push({
          location: `${relLabel}:llm_binding[${i}].api_key`,
          reason: "Unstripped llm_binding api_key",
        });
      }
    }

    if (tables.has("meta_instance_upstream_config")) {
      const rows = db
        .prepare("SELECT api_key FROM meta_instance_upstream_config WHERE api_key IS NOT NULL AND api_key != ''")
        .all() as Array<{ api_key: string }>;
      for (let i = 0; i < rows.length; i++) {
        findings.push({
          location: `${relLabel}:meta_instance_upstream_config[${i}].api_key`,
          reason: "Unstripped upstream api_key",
        });
      }
    }

    if (tables.has("meta_users")) {
      const rows = db
        .prepare("SELECT user_id, password FROM meta_users WHERE password IS NOT NULL AND password != ''")
        .all() as Array<{ user_id: string; password: string }>;
      for (const r of rows) {
        findings.push({
          location: `${relLabel}:meta_users(${r.user_id}).password`,
          reason: "Unstripped meta_users.password",
        });
      }
    }

    if (tables.has("meta_config_params")) {
      const rows = db
        .prepare("SELECT module, param_name, param_value FROM meta_config_params WHERE param_value != ''")
        .all() as Array<{ module: string; param_name: string; param_value: string }>;
      for (const r of rows) {
        if (
          r.module === "backup" &&
          (r.param_name === "drive_refresh_token" || r.param_name === "drive_client_secret")
        ) {
          findings.push({
            location: `${relLabel}:meta_config_params(${r.module}.${r.param_name})`,
            reason: `Unstripped ${r.param_name}`,
          });
        }
        scanTextForSecrets(
          r.param_value,
          `${relLabel}:meta_config_params(${r.module}.${r.param_name})`,
          findings,
        );
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Scan the staging snapshot directory before packing into tar.gz.
 * Checks all config files (`config/**`) and database config tables (`metadata.db`, `knowledge.db`).
 */
export function scanStagingSnapshotForSecrets(stagingDir: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];

  // 1. Scan all files under `config/`
  const configDir = path.join(stagingDir, "config");
  if (existsSync(configDir)) {
    const walkConfig = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(stagingDir, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          walkConfig(full);
        } else if (entry.isFile()) {
          if (entry.name === ".env" || entry.name.endsWith(".env")) {
            scanEnvFile(full, rel, findings);
          } else {
            const text = readFileSync(full, "utf8");
            scanTextForSecrets(text, rel, findings);
          }
        }
      }
    };
    walkConfig(configDir);
  }

  // 2. Scan SQLite databases (`core-data/metadata/*/metadata.db` and `panel-data/knowledge.db`)
  const metaDir = path.join(stagingDir, "core-data", "metadata");
  if (existsSync(metaDir)) {
    for (const sub of readdirSync(metaDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const dbFile = path.join(metaDir, sub.name, "metadata.db");
      if (existsSync(dbFile)) {
        scanSqliteConfigTables(dbFile, `core-data/metadata/${sub.name}/metadata.db`, findings);
      }
    }
  }

  const knowledgeDb = path.join(stagingDir, "panel-data", "knowledge.db");
  if (existsSync(knowledgeDb)) {
    scanSqliteConfigTables(knowledgeDb, "panel-data/knowledge.db", findings);
  }

  return findings;
}
