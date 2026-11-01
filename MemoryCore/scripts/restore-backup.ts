#!/usr/bin/env node
/**
 * Standalone restore CLI for encrypted Memory Hub backup archives (`pmh-backup-*.tar.gz.age`).
 *
 * Usage:
 *   node --import tsx MemoryCore/scripts/restore-backup.ts <backup-file.tar.gz.age> <target-dir> [--password <pw>]
 *
 * Features:
 *   - Reads the cleartext header (`PMH-AGE-V1`) to display the required password version (`v1`, `v2`, ...)
 *     and scrypt parameters without needing the server database.
 *   - Prompts for the password interactively (or reads `--password` / `PMH_BACKUP_PASSWORD`).
 *   - Re-derives the X25519 private key via scrypt + salt, decrypts the `.tar.gz`, and extracts
 *     into `<target-dir>` with Windows long-path (`\\?\`) support.
 *   - Runs `PRAGMA integrity_check` on restored SQLite databases (`vectors.db`, `metadata.db`, `knowledge.db`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { decryptBackupPayload, readBackupFileHeader } from "../src/backup/crypto.js";
import { extractTarGzToDirectory, toLongPath } from "../src/backup/archive.js";
import { verifySqliteIntegrity } from "../src/backup/sanitize.js";

async function promptPassword(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function restoreBackupArchive(opts: {
  archivePath: string;
  targetDir: string;
  password: string;
}): Promise<{
  keyVersion: number;
  fileCount: number;
  verifiedDbs: string[];
}> {
  const encrypted = readFileSync(toLongPath(opts.archivePath));
  const { plaintext, header } = decryptBackupPayload(encrypted, opts.password);
  const { fileCount } = extractTarGzToDirectory(plaintext, opts.targetDir);

  const verifiedDbs: string[] = [];
  const candidates = [
    path.join(opts.targetDir, "core-data", "vectors.db"),
    path.join(opts.targetDir, "panel-data", "knowledge.db"),
  ];
  const metaRoot = path.join(opts.targetDir, "core-data", "metadata");
  if (existsSync(toLongPath(metaRoot))) {
    for (const sub of readdirSync(toLongPath(metaRoot), { withFileTypes: true })) {
      if (sub.isDirectory()) {
        candidates.push(path.join(metaRoot, sub.name, "metadata.db"));
      }
    }
  }

  for (const dbFile of candidates) {
    if (existsSync(toLongPath(dbFile))) {
      verifySqliteIntegrity(toLongPath(dbFile));
      verifiedDbs.push(path.relative(opts.targetDir, dbFile).split(path.sep).join("/"));
    }
  }

  return {
    keyVersion: header.keyVersion,
    fileCount,
    verifiedDbs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let archivePath = "";
  let targetDir = "";
  let password = process.env.PMH_BACKUP_PASSWORD ?? "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--password" || a === "-p") {
      password = args[++i] ?? "";
    } else if (!archivePath) {
      archivePath = a;
    } else if (!targetDir) {
      targetDir = a;
    }
  }

  if (!archivePath || !targetDir) {
    console.error(
      "Usage: npx tsx MemoryCore/scripts/restore-backup.ts <backup-file.tar.gz.age> <target-dir> [--password <pw>]",
    );
    process.exit(1);
  }

  const encrypted = readFileSync(toLongPath(archivePath));
  const { header } = readBackupFileHeader(encrypted);
  console.log(`Backup file: ${path.basename(archivePath)} (requires password version v${header.keyVersion})`);

  if (!password) {
    password = await promptPassword(`Enter backup password (v${header.keyVersion}): `);
  }

  const res = await restoreBackupArchive({ archivePath, targetDir, password });
  console.log(
    `Restored ${res.fileCount} files (key v${res.keyVersion}) into ${ path.resolve(targetDir) }`,
  );
  if (res.verifiedDbs.length > 0) {
    console.log(`SQLite integrity_check passed: ${res.verifiedDbs.join(", ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
