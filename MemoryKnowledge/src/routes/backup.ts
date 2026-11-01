/**
 * Internal Backup Snapshot Routes — Mounted under /v3/internal/backup.
 *
 * POST /snapshot
 *   Takes a consistent snapshot of `panel-data` (the knowledge service's `dataDir`)
 *   into a target directory inside the shared staging root:
 *     1. `knowledge.db` via better-sqlite3 online `.backup()` API (no WAL/SHM needed),
 *        then sanitizes `knowledge_connector.token = ''` and `llm_binding.api_key = ''`
 *        on the snapshot copy (never touches the live DB), and runs `PRAGMA integrity_check`.
 *     2. Any nested `.db` files under `dataDir` (such as per-wiki `index.db`) via
 *        better-sqlite3 `.backup()` + `PRAGMA integrity_check`.
 *     3. All other files (wiki markdown, raw sources, etc.), skipping `logs`, `_wiki_engines`,
 *        and `-wal` / `-shm` files.
 */

import { Hono } from "hono";
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { wrapOk, wrapError } from "../api-helpers.js";

export interface BackupRouteDeps {
  dataDir: string;
  dbPath: string;
  rawDb: Database.Database;
  stagingRoot?: string;
}

const SKIP_TOP_DIRS = new Set(["_wiki_engines", "logs", ".backup", "backup-staging"]);

function isSqliteSidecar(name: string): boolean {
  return name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal");
}

async function backupSqliteFile(srcDb: Database.Database, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath)) rmSync(destPath, { force: true });
  await srcDb.backup(destPath);
}

function checkAndSanitizeKnowledgeDb(snapshotPath: string): void {
  const snap = new Database(snapshotPath);
  try {
    snap.pragma("journal_mode = DELETE");
    const tables = new Set(
      (snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    if (tables.has("knowledge_connector")) {
      snap.prepare("UPDATE knowledge_connector SET token = ''").run();
    }
    if (tables.has("llm_binding")) {
      snap.prepare("UPDATE llm_binding SET api_key = ''").run();
    }
    snap.exec("VACUUM");
    const check = snap.pragma("integrity_check", { simple: true });
    if (check !== "ok") {
      throw new Error(`knowledge.db integrity_check failed: ${String(check)}`);
    }
  } finally {
    snap.close();
  }
}

async function snapshotNestedSqliteFile(srcPath: string, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath)) rmSync(destPath, { force: true });
  const src = new Database(srcPath, { readonly: true });
  try {
    await src.backup(destPath);
  } finally {
    src.close();
  }
  const snap = new Database(destPath);
  try {
    snap.pragma("journal_mode = DELETE");
    const check = snap.pragma("integrity_check", { simple: true });
    if (check !== "ok") {
      throw new Error(`${srcPath} integrity_check failed: ${String(check)}`);
    }
  } finally {
    snap.close();
  }
}

async function walkAndCopyPanelData(
  rootDir: string,
  currentDir: string,
  targetRoot: string,
  mainDbAbs: string,
  stats: { dbCount: number; fileCount: number },
): Promise<void> {
  if (!existsSync(currentDir)) return;
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const srcFull = join(currentDir, entry.name);
    const rel = relative(rootDir, srcFull);
    if (currentDir === rootDir && SKIP_TOP_DIRS.has(entry.name)) continue;
    if (isSqliteSidecar(entry.name)) continue;

    const dstFull = join(targetRoot, rel);
    if (entry.isDirectory()) {
      mkdirSync(dstFull, { recursive: true });
      await walkAndCopyPanelData(rootDir, srcFull, targetRoot, mainDbAbs, stats);
    } else if (entry.isFile()) {
      if (resolve(srcFull) === mainDbAbs) {
        continue; // handled via live rawDb.backup()
      }
      if (entry.name.endsWith(".db")) {
        await snapshotNestedSqliteFile(srcFull, dstFull);
        stats.dbCount += 1;
      } else {
        mkdirSync(dirname(dstFull), { recursive: true });
        cpSync(srcFull, dstFull);
        stats.fileCount += 1;
      }
    }
  }
}

export function createBackupRoutes(deps: BackupRouteDeps): Hono {
  const app = new Hono();
  const stagingRoot = resolve(
    deps.stagingRoot ?? process.env.PMH_BACKUP_STAGING_DIR ?? "/data/backup-staging",
  );

  app.post("/snapshot", async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    const subdir = typeof body.subdir === "string" ? body.subdir.trim() : "";
    if (!subdir || subdir.includes("..") || subdir.includes("/") || subdir.includes("\\")) {
      return c.json(wrapError(400, "valid subdir is required"), 400);
    }

    const targetDir = resolve(stagingRoot, subdir, "panel-data");
    if (!targetDir.startsWith(stagingRoot)) {
      return c.json(wrapError(400, "invalid targetDir"), 400);
    }

    try {
      mkdirSync(targetDir, { recursive: true });
      const mainDbAbs = resolve(deps.dbPath);
      const snapshotDbPath = join(targetDir, "knowledge.db");
      await backupSqliteFile(deps.rawDb, snapshotDbPath);
      checkAndSanitizeKnowledgeDb(snapshotDbPath);

      const stats = { dbCount: 1, fileCount: 0 };
      await walkAndCopyPanelData(resolve(deps.dataDir), resolve(deps.dataDir), targetDir, mainDbAbs, stats);

      return c.json(
        wrapOk({
          target_dir: targetDir,
          db_count: stats.dbCount,
          file_count: stats.fileCount,
        }),
      );
    } catch (err) {
      return c.json(
        wrapError(500, `knowledge snapshot failed: ${err instanceof Error ? err.message : String(err)}`),
        500,
      );
    }
  });

  return app;
}
