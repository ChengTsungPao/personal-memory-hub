/**
 * Google Drive OAuth 2.0 Device Flow (`drive.file` scope) & file upload/retention client (Design Doc §7, §8).
 *
 * - Uses only `https://www.googleapis.com/auth/drive.file` so the app can only see and
 *   manage files/folders it created itself.
 * - Supports OAuth 2.0 for TV and Limited-Input Device Applications:
 *     1. `startDeviceAuthorization(clientId)` -> returns `{ device_code, user_code, verification_url, expires_in, interval }`
 *     2. `pollDeviceToken(clientId, clientSecret, deviceCode)` -> exchanges for `{ access_token, refresh_token }`
 *     3. `refreshAccessToken(clientId, clientSecret, refreshToken)` -> returns fresh `access_token`
 * - Ensures target folder path (e.g. `backup/personal_memory_hub/`) exists in Google Drive,
 *   uploads encrypted backup files (`pmh-backup-YYYYMMDD-HHmm-v{version}.tar.gz.age`),
 *   and optionally prunes backup files older than 30 days in that folder matching the backup filename regex.
 */

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

/**
 * Default public Desktop OAuth 2.0 client for 1-click localhost loopback redirect flow
 * (RFC 8252 §8.5 — native/desktop apps treat client_secret as non-confidential).
 */
export const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = "202264815644.apps.googleusercontent.com";
export const DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET = Buffer.from(
  "X0R3cW9zUFdlakZIaFducnNpWUJKaF9E",
  "base64",
).toString("utf8");

export const BACKUP_FILENAME_REGEX = /^pmh-backup-(\d{8})-(\d{4})-v(\d+)\.tar\.gz\.age$/;

export interface DeviceAuthSession {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface OAuthRedirectSession {
  auth_url: string;
  state: string;
  redirect_uri: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export function buildGoogleOAuthAuthorizeUrl(params: {
  clientId?: string;
  redirectUri: string;
  state: string;
}): string {
  const clientId = params.clientId?.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GOOGLE_DRIVE_FILE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: params.state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${query.toString()}`;
}

export async function exchangeAuthorizationCode(
  params: {
    clientId?: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenResponse> {
  const clientId = params.clientId?.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = params.clientSecret?.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code.trim(),
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google code exchange failed (${res.status}): ${String(data.error_description ?? data.error ?? "unknown")}`,
    );
  }
  return {
    access_token: String(data.access_token ?? ""),
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in: Number(data.expires_in ?? 3600),
    token_type: String(data.token_type ?? "Bearer"),
  };
}

export async function startDeviceAuthorization(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthSession> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    scope: GOOGLE_DRIVE_FILE_SCOPE,
  });
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Google device auth failed (${res.status}): ${String(data.error_description ?? data.error ?? "unknown")}`,
    );
  }
  return {
    device_code: String(data.device_code ?? ""),
    user_code: String(data.user_code ?? ""),
    verification_url: String(data.verification_url ?? data.verification_url_complete ?? "https://www.google.com/device"),
    expires_in: Number(data.expires_in ?? 1800),
    interval: Number(data.interval ?? 5),
  };
}

export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "pending" | "authorized"; tokens?: OAuthTokenResponse }> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    device_code: deviceCode.trim(),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errCode = String(data.error ?? "");
    if (errCode === "authorization_pending" || errCode === "slow_down") {
      return { status: "pending" };
    }
    throw new Error(
      `Google token poll failed (${errCode || res.status}): ${String(data.error_description ?? data.error ?? "")}`,
    );
  }
  return {
    status: "authorized",
    tokens: {
      access_token: String(data.access_token ?? ""),
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expires_in: Number(data.expires_in ?? 3600),
      token_type: String(data.token_type ?? "Bearer"),
    },
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    refresh_token: refreshToken.trim(),
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token refresh failed (${res.status}): ${String(data.error_description ?? data.error ?? "no access_token")}`,
    );
  }
  return String(data.access_token);
}

function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateSingleFolder(
  accessToken: string,
  name: string,
  parentId: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const q = `name = '${escapeDriveQueryString(name)}' and '${escapeDriveQueryString(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const searchRes = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const searchData = (await searchRes.json().catch(() => ({}))) as {
    files?: Array<{ id: string; name: string }>;
    error?: { message?: string };
  };
  if (!searchRes.ok) {
    throw new Error(
      `Drive folder search failed (${searchRes.status}): ${searchData.error?.message ?? "unknown"}`,
    );
  }
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0]!.id;
  }

  const createRes = await fetchImpl(DRIVE_FILES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const createData = (await createRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!createRes.ok || !createData.id) {
    throw new Error(
      `Drive folder create failed (${createRes.status}): ${createData.error?.message ?? "unknown"}`,
    );
  }
  return createData.id;
}

/**
 * Resolve or create a nested Drive folder path like `backup/personal_memory_hub/`.
 */
export async function ensureDriveFolderPath(
  accessToken: string,
  folderPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const segments = folderPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let parentId = "root";
  for (const seg of segments) {
    parentId = await findOrCreateSingleFolder(accessToken, seg, parentId, fetchImpl);
  }
  return parentId;
}

/**
 * Upload an encrypted backup buffer to the resolved Google Drive folder.
 */
export async function uploadFileToDriveFolder(
  accessToken: string,
  folderId: string,
  fileName: string,
  content: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<{ fileId: string; name: string }> {
  const boundary = `pmh_backup_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name: fileName, parents: [folderId] })}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const closingPart = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const multipartBody = Buffer.concat([metadataPart, content, closingPart]);

  const res = await fetchImpl(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(multipartBody.length),
    },
    body: multipartBody,
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    error?: { message?: string };
  };
  if (!res.ok || !data.id) {
    throw new Error(
      `Drive file upload failed (${res.status}): ${data.error?.message ?? "unknown"}`,
    );
  }
  return { fileId: data.id, name: data.name ?? fileName };
}

/**
 * Parse the UTC timestamp (ms) from a backup filename `pmh-backup-YYYYMMDD-HHmm-v{N}.tar.gz.age`,
 * or null if the filename does not match the strict backup naming pattern.
 */
export function parseBackupFilenameDateMs(fileName: string): number | null {
  const m = fileName.match(BACKUP_FILENAME_REGEX);
  if (!m) return null;
  const datePart = m[1]!;
  const timePart = m[2]!;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  return Date.UTC(year, month, day, hour, minute);
}

/**
 * Delete backup files older than `maxAgeDays` (e.g. 30 days) inside `folderId` on Google Drive.
 * Only touches files matching `BACKUP_FILENAME_REGEX`.
 */
export async function pruneOldDriveBackups(
  accessToken: string,
  folderId: string,
  maxAgeDays = 30,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const q = `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`;
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&pageSize=200&spaces=drive`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    files?: Array<{ id: string; name: string; createdTime?: string }>;
  };
  if (!res.ok || !data.files) return [];

  const deleted: string[] = [];
  for (const f of data.files) {
    const fileDateMs = parseBackupFilenameDateMs(f.name);
    if (fileDateMs === null) continue; // Never touch files that don't match our exact backup naming rule
    if (fileDateMs < cutoffMs) {
      const delRes = await fetchImpl(`${DRIVE_FILES_URL}/${encodeURIComponent(f.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (delRes.ok || delRes.status === 204) {
        deleted.push(f.name);
      }
    }
  }
  return deleted;
}
