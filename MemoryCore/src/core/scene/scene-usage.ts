/**
 * When each L2 scene file was last read by an agent (`/scenario/read`), kept in
 * `.metadata/scene_usage.json` as `{ [filename]: ISO time }`.
 *
 * `heat` in META counts pipeline writes, not reads, so it cannot tell a file nobody
 * reads any more from one that is still in use. A file is expired when neither an
 * agent read nor a pipeline update has touched it for EXPIRE_DAYS. Expired files
 * are only marked in the UI; nothing is deleted.
 */

import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";

export const EXPIRE_DAYS = 30;

export async function readSceneUsage(storage: StorageAdapter): Promise<Record<string, string>> {
  try {
    const raw = await storage.readFile(StoragePaths.sceneUsage);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function markSceneUsed(storage: StorageAdapter, filename: string, now = new Date()): Promise<void> {
  const usage = await readSceneUsage(storage);
  usage[filename] = now.toISOString();
  await storage.writeFile(StoragePaths.sceneUsage, JSON.stringify(usage, null, 2));
}

/** Latest of the given ISO times; unparseable or missing ones are ignored. */
export function lastActivity(...times: Array<string | undefined>): string | undefined {
  let best: number | undefined;
  for (const t of times) {
    const ms = t ? Date.parse(t) : NaN;
    if (!Number.isNaN(ms) && (best === undefined || ms > best)) best = ms;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

export function isSceneExpired(lastActivityAt: string | undefined, now = new Date()): boolean {
  if (!lastActivityAt) return false;
  return now.getTime() - Date.parse(lastActivityAt) > EXPIRE_DAYS * 86_400_000;
}
