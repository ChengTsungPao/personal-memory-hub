/**
 * Pure Node.js POSIX ustar tar.gz packer & extractor with Windows long-path (`\\?\`) support.
 *
 * Design Doc §3 / §13:
 *   `core-data/instances/.../memory-generation-logs/` has filenames ~200 chars long.
 *   We use POSIX ustar + PAX extended headers (`path=...`) when relative paths exceed
 *   100 bytes, and on Windows extraction we normalize paths with `path.toNamespacedPath()`
 *   so paths > 260 chars write cleanly without `ENAMETOOLONG` / `ENOENT`.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

function writeOctal(buf: Buffer, offset: number, length: number, val: number): void {
  const oct = val.toString(8).padStart(length - 1, "0");
  buf.write(oct, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function finalizeHeaderChecksum(header: Buffer): void {
  // Fill checksum field (148..156) with spaces first
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  const oct = sum.toString(8).padStart(6, "0");
  header.write(oct, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function buildUstarHeader(opts: {
  name: string;
  size: number;
  mtimeSec: number;
  typeflag: string; // '0' = file, '5' = dir, 'x' = PAX extended header
  mode?: number;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(opts.name, "utf8");
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

  writeOctal(header, 100, 8, opts.mode ?? (opts.typeflag === "5" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, opts.size);
  writeOctal(header, 136, 12, opts.mtimeSec);
  header.write(opts.typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  finalizeHeaderChecksum(header);
  return header;
}

function buildPaxPathBlock(fullRelPath: string, mtimeSec: number): Buffer {
  const kv = `path=${fullRelPath}\n`;
  const kvBytes = Buffer.from(kv, "utf8");
  // PAX record format: "<length> path=<value>\n" where <length> includes the length digits + space + kvBytes
  let totalLen = kvBytes.length + 3;
  while (true) {
    const line = `${totalLen} ${kv}`;
    const actual = Buffer.byteLength(line, "utf8");
    if (actual === totalLen) break;
    totalLen = actual;
  }
  const paxPayload = Buffer.from(`${totalLen} ${kv}`, "utf8");
  const paxHeader = buildUstarHeader({
    name: "PaxHeader/longpath",
    size: paxPayload.length,
    mtimeSec,
    typeflag: "x",
    mode: 0o644,
  });
  const paddedLen = Math.ceil(paxPayload.length / 512) * 512;
  const paddedPayload = Buffer.alloc(paddedLen, 0);
  paxPayload.copy(paddedPayload);
  return Buffer.concat([paxHeader, paddedPayload]);
}

/**
 * Normalize a filesystem path on Windows so paths > 260 chars work cleanly.
 */
export function toLongPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? path.toNamespacedPath(resolved) : resolved;
}

function collectFilesRecursively(
  rootDir: string,
  currentDir: string,
  out: Array<{ relPath: string; fullPath: string; isDir: boolean; mtimeSec: number }>,
): void {
  const entries = readdirSync(toLongPath(currentDir), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    const st = statSync(toLongPath(fullPath));
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    if (entry.isDirectory()) {
      out.push({ relPath: `${relPath}/`, fullPath, isDir: true, mtimeSec });
      collectFilesRecursively(rootDir, fullPath, out);
    } else if (entry.isFile()) {
      out.push({ relPath, fullPath, isDir: false, mtimeSec });
    }
  }
}

/**
 * Create a `.tar.gz` Buffer from a source directory.
 */
export function createTarGzFromDirectory(sourceDir: string): Buffer {
  const items: Array<{ relPath: string; fullPath: string; isDir: boolean; mtimeSec: number }> = [];
  collectFilesRecursively(sourceDir, sourceDir, items);

  const chunks: Buffer[] = [];
  for (const item of items) {
    const pathBytes = Buffer.byteLength(item.relPath, "utf8");
    if (pathBytes > 99) {
      chunks.push(buildPaxPathBlock(item.relPath, item.mtimeSec));
    }
    if (item.isDir) {
      chunks.push(
        buildUstarHeader({
          name: item.relPath.slice(-99),
          size: 0,
          mtimeSec: item.mtimeSec,
          typeflag: "5",
        }),
      );
    } else {
      const data = readFileSync(toLongPath(item.fullPath));
      chunks.push(
        buildUstarHeader({
          name: item.relPath.slice(-99),
          size: data.length,
          mtimeSec: item.mtimeSec,
          typeflag: "0",
        }),
      );
      chunks.push(data);
      const remainder = data.length % 512;
      if (remainder > 0) {
        chunks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  // End-of-archive: two 512-byte zero blocks
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function parsePaxPath(payload: Buffer): string | null {
  const text = payload.toString("utf8");
  for (const line of text.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const kv = line.slice(sp + 1);
    if (kv.startsWith("path=")) {
      return kv.slice("path=".length);
    }
  }
  return null;
}

/**
 * Extract a `.tar.gz` Buffer into `targetDir` with path-traversal protection and Windows long-path support.
 */
export function extractTarGzToDirectory(tarGz: Buffer, targetDir: string): { fileCount: number } {
  const tar = gunzipSync(tarGz);
  const absTargetRoot = path.resolve(targetDir);
  mkdirSync(toLongPath(absTargetRoot), { recursive: true });

  let offset = 0;
  let pendingPaxPath: string | null = null;
  let fileCount = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;

    // Check if entire block is zero (EOF)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const sizeOct = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    const typeflag = String.fromCharCode(header[156]!);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const payload = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === "x") {
      pendingPaxPath = parsePaxPath(payload);
      continue;
    }

    const relName = (pendingPaxPath ?? (prefix ? `${prefix}/${rawName}` : rawName)).replace(
      /^\/+/,
      "",
    );
    pendingPaxPath = null;
    if (!relName) continue;

    // Prevent path traversal
    const normalizedRel = relName.split("/").filter((seg) => seg && seg !== ".").join(path.sep);
    if (relName.split("/").includes("..")) {
      throw new Error(`UNSAFE_ARCHIVE_PATH: ${relName}`);
    }
    const destPath = path.resolve(absTargetRoot, normalizedRel);
    if (!destPath.startsWith(absTargetRoot)) {
      throw new Error(`UNSAFE_ARCHIVE_PATH: ${relName}`);
    }

    if (typeflag === "5" || relName.endsWith("/")) {
      mkdirSync(toLongPath(destPath), { recursive: true });
    } else if (typeflag === "0" || typeflag === "\0") {
      mkdirSync(toLongPath(path.dirname(destPath)), { recursive: true });
      writeFileSync(toLongPath(destPath), payload);
      fileCount += 1;
    }
  }

  return { fileCount };
}
