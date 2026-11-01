/**
 * Backup Engine & Daily Scheduler (Design Doc §3, §4, §6, §7, §8).
 *
 * Lives in `memory-core`. Holds:
 *   - Configuration & state in `meta_config_params` (`module = 'backup'`, `scope = 'global'`).
 *   - Append-only password audit log (`password_audit_log` JSON array in `meta_config_params`).
 *   - Daily scheduler (runs at `schedule_hour` in `Asia/Taipei`, default 04:00; catches up on
 *     startup if today's scheduled run was missed).
 *   - Full backup pipeline:
 *       1. Consistent online SQLite backup (`node:sqlite` `backup()`) of `vectors.db` and
 *          `metadata/tdai_metadata_default/metadata.db` (excluding `tdai_metadata_e2e-test`).
 *       2. Sanitize `metadata.db` snapshot + `PRAGMA integrity_check` on all DB snapshots.
 *       3. Copy `conversations`, `records`, `scene_blocks`, `profiles`, `instances` from `core-data`.
 *       4. Call `memory-hub` (`KNOWLEDGE_URL/v3/internal/backup/snapshot`) so it snapshots
 *          `knowledge.db` + per-wiki `index.db` + wiki markdown files into the shared staging dir.
 *       5. Copy `agents.json` and `admin-key`, plus sanitized copies of `.env`, `tdai-gateway.yaml`,
 *          and `llm-gateway` `.env` & `config.json` (when mounted).
 *       6. Run secret scanner on staging config files & DB config tables; abort immediately if
 *          any unstripped secret is found.
 *       7. Pack into `.tar.gz` and encrypt with the stored X25519 public key (`pmh-backup-YYYYMMDD-HHmm-v{N}.tar.gz.age`).
 *       8. Write to local backup folder and upload to Google Drive (if authorized), then apply
 *          optional 30-day retention cleanup on both local and Drive.
 */

import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { IMetadataStore } from "../metadata/store/interface.js";
import { createTarGzFromDirectory } from "./archive.js";
import {
  DEFAULT_SCRYPT_PARAMS,
  derivePublicKeyFromPassword,
  encryptBackupPayload,
  type ScryptParams,
  verifyPasswordAgainstPublicKey,
} from "./crypto.js";
import {
  BACKUP_FILENAME_REGEX,
  type DeviceAuthSession,
  ensureDriveFolderPath,
  parseBackupFilenameDateMs,
  pollDeviceToken,
  pruneOldDriveBackups,
  refreshAccessToken,
  startDeviceAuthorization,
  uploadFileToDriveFolder,
} from "./drive.js";
import {
  sanitizeAndCheckMetadataDb,
  sanitizeEnvContent,
  sanitizeGatewayYamlContent,
  sanitizeJsonConfigContent,
  scanStagingSnapshotForSecrets,
  verifySqliteIntegrity,
} from "./sanitize.js";

const require = createRequire(import.meta.url);
function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

export interface PasswordAuditEntry {
  event: "set" | "change";
  at: string;
  old_version: number | null;
  new_version: number;
  user_id: string;
  public_key_fingerprint: string;
}

export interface BackupRunRecord {
  status: "success" | "failed" | "running";
  started_at: string;
  finished_at?: string;
  file_name?: string;
  size_bytes?: number;
  key_version?: number;
  drive_file_id?: string;
  error?: string;
  trigger: "manual" | "scheduled" | "catchup";
}

export interface BackupPublicStatus {
  enabled: boolean;
  has_password: boolean;
  key_version: number;
  public_key_fingerprint: string | null;
  password_updated_at: string | null;
  drive_path: string;
  drive_client_id: string;
  drive_has_client_secret: boolean;
  drive_authorized: boolean;
  delete_older_than_month: boolean;
  schedule_hour: number;
  timezone: string;
  last_run: BackupRunRecord | null;
  next_scheduled_at: string | null;
  audit_log: PasswordAuditEntry[];
}

export interface BackupEngineDeps {
  coreDataDir: string;
  stagingRootDir: string;
  localBackupDir: string;
  getVectorDb: () => DatabaseSync | null;
  getMetadataStore: (instanceId: string) => Promise<IMetadataStore>;
  knowledgeInternalUrl?: string;
  knowledgeServiceKey?: string;
  hostFiles?: {
    adminKeyPath?: string;
    agentsJsonPath?: string;
    globalEnvPath?: string;
    gatewayYamlPath?: string;
    claudeProxyEnvPath?: string;
    llmGatewayEnvPath?: string;
    llmGatewayConfigJsonPath?: string;
  };
  fetchImpl?: typeof fetch;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const BACKUP_MODULE = "backup";
const DEFAULT_DRIVE_PATH = "backup/personal_memory_hub/";
const DEFAULT_SCHEDULE_HOUR = 4; // 04:00 Asia/Taipei
const BACKUP_TIMEZONE = "Asia/Taipei";

const CORE_DATA_COPY_DIRS = ["conversations", "records", "scene_blocks", "profiles", "instances"];

function formatTaipeiParts(ms: number): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  dateKey: string;
} {
  // UTC+8 fixed offset for Asia/Taipei (Taiwan has no DST)
  const taipeiDate = new Date(ms + 8 * 3600 * 1000);
  const year = String(taipeiDate.getUTCFullYear());
  const month = String(taipeiDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(taipeiDate.getUTCDate()).padStart(2, "0");
  const hour = String(taipeiDate.getUTCHours()).padStart(2, "0");
  const minute = String(taipeiDate.getUTCMinutes()).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    dateKey: `${year}-${month}-${day}`,
  };
}

function computeNextScheduledIso(scheduleHour: number, nowMs = Date.now()): string {
  const taipeiNow = new Date(nowMs + 8 * 3600 * 1000);
  const target = new Date(taipeiNow.getTime());
  target.setUTCHours(scheduleHour, 0, 0, 0);
  if (target.getTime() <= taipeiNow.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return new Date(target.getTime() - 8 * 3600 * 1000).toISOString();
}

export class BackupEngine {
  private readonly deps: BackupEngineDeps;
  private readonly fetchImpl: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private runningPromise: Promise<BackupRunRecord> | null = null;
  private pendingDeviceSession: {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_at_ms: number;
  } | null = null;

  constructor(deps: BackupEngineDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async getParamMap(instanceId = "default"): Promise<Map<string, string>> {
    const store = await this.deps.getMetadataStore(instanceId);
    const list = await store.listConfigParams({ module: BACKUP_MODULE, scope: "global" });
    return new Map(list.map((item) => [item.param_name, item.param_value]));
  }

  private async setParam(
    name: string,
    value: string,
    description = "Backup configuration",
    instanceId = "default",
  ): Promise<void> {
    const store = await this.deps.getMetadataStore(instanceId);
    await store.upsertConfigParam({
      scope: "global",
      user_id: null,
      module: BACKUP_MODULE,
      param_name: name,
      param_value: value,
      description,
    });
  }

  async getStatus(instanceId = "default"): Promise<BackupPublicStatus> {
    const map = await this.getParamMap(instanceId);
    const enabled = map.get("enabled") === "true";
    const keyVersion = Number(map.get("key_version") ?? "0");
    const publicKeyHex = map.get("public_key_hex") ?? "";
    const fingerprint = map.get("public_key_fingerprint") || null;
    const passwordUpdatedAt = map.get("password_updated_at") || null;
    const drivePath = map.get("drive_path") || DEFAULT_DRIVE_PATH;
    const driveClientId = map.get("drive_client_id") ?? "";
    const driveClientSecret = map.get("drive_client_secret") ?? "";
    const driveRefreshToken = map.get("drive_refresh_token") ?? "";
    const deleteOlderThanMonth = map.get("delete_older_than_month") === "true";
    const scheduleHour = Number(map.get("schedule_hour") ?? String(DEFAULT_SCHEDULE_HOUR));

    let lastRun: BackupRunRecord | null = null;
    try {
      const rawLast = map.get("last_run_json");
      if (rawLast) lastRun = JSON.parse(rawLast) as BackupRunRecord;
    } catch {
      lastRun = null;
    }

    let auditLog: PasswordAuditEntry[] = [];
    try {
      const rawAudit = map.get("password_audit_log");
      if (rawAudit) auditLog = JSON.parse(rawAudit) as PasswordAuditEntry[];
    } catch {
      auditLog = [];
    }

    return {
      enabled,
      has_password: Boolean(publicKeyHex && keyVersion > 0),
      key_version: keyVersion,
      public_key_fingerprint: fingerprint,
      password_updated_at: passwordUpdatedAt,
      drive_path: drivePath,
      drive_client_id: driveClientId,
      drive_has_client_secret: Boolean(driveClientSecret),
      drive_authorized: Boolean(driveRefreshToken),
      delete_older_than_month: deleteOlderThanMonth,
      schedule_hour: Number.isFinite(scheduleHour) ? scheduleHour : DEFAULT_SCHEDULE_HOUR,
      timezone: BACKUP_TIMEZONE,
      last_run: lastRun,
      next_scheduled_at: enabled ? computeNextScheduledIso(scheduleHour) : null,
      audit_log: auditLog,
    };
  }

  /**
   * Set initial backup password or change an existing password (requires `oldPassword` when a key already exists).
   * Appends an immutable record to `password_audit_log`.
   */
  async setOrChangePassword(opts: {
    userId: string;
    oldPassword?: string;
    newPassword: string;
    confirmPassword: string;
    scryptParams?: ScryptParams;
    instanceId?: string;
  }): Promise<{ key_version: number; public_key_fingerprint: string }> {
    const instanceId = opts.instanceId ?? "default";
    if (opts.newPassword !== opts.confirmPassword) {
      throw new Error("PASSWORD_MISMATCH: The two password inputs do not match");
    }
    if (!opts.newPassword || opts.newPassword.length < 12) {
      throw new Error("PASSWORD_TOO_SHORT: Password must be at least 12 characters");
    }

    const map = await this.getParamMap(instanceId);
    const existingPubHex = map.get("public_key_hex") ?? "";
    const existingSaltHex = map.get("salt_hex") ?? "";
    const existingVersion = Number(map.get("key_version") ?? "0");
    let existingScrypt = DEFAULT_SCRYPT_PARAMS;
    try {
      const rawScrypt = map.get("scrypt_params_json");
      if (rawScrypt) existingScrypt = JSON.parse(rawScrypt) as ScryptParams;
    } catch {
      /* default */
    }

    const isChange = Boolean(existingPubHex && existingVersion > 0);
    if (isChange) {
      if (!opts.oldPassword) {
        throw new Error("OLD_PASSWORD_REQUIRED: Existing backup password is required to change password");
      }
      const ok = verifyPasswordAgainstPublicKey(
        opts.oldPassword,
        existingSaltHex,
        existingPubHex,
        existingScrypt,
      );
      if (!ok) {
        throw new Error("INVALID_OLD_PASSWORD: Old backup password is incorrect");
      }
    }

    const derived = derivePublicKeyFromPassword(
      opts.newPassword,
      undefined,
      opts.scryptParams ?? DEFAULT_SCRYPT_PARAMS,
    );
    const newVersion = isChange ? existingVersion + 1 : 1;
    const now = new Date().toISOString();

    let auditLog: PasswordAuditEntry[] = [];
    try {
      const rawAudit = map.get("password_audit_log");
      if (rawAudit) auditLog = JSON.parse(rawAudit) as PasswordAuditEntry[];
    } catch {
      auditLog = [];
    }
    auditLog.push({
      event: isChange ? "change" : "set",
      at: now,
      old_version: isChange ? existingVersion : null,
      new_version: newVersion,
      user_id: opts.userId,
      public_key_fingerprint: derived.fingerprint,
    });

    await this.setParam("salt_hex", derived.saltHex, "Scrypt salt for backup key", instanceId);
    await this.setParam(
      "scrypt_params_json",
      JSON.stringify(derived.scryptParams),
      "Scrypt cost parameters",
      instanceId,
    );
    await this.setParam("public_key_hex", derived.publicKeyHex, "X25519 public key", instanceId);
    await this.setParam(
      "public_key_fingerprint",
      derived.fingerprint,
      "SHA-256 fingerprint of X25519 public key",
      instanceId,
    );
    await this.setParam("key_version", String(newVersion), "Backup password version", instanceId);
    await this.setParam("password_updated_at", now, "Password updated timestamp", instanceId);
    await this.setParam(
      "password_audit_log",
      JSON.stringify(auditLog),
      "Append-only password change audit log",
      instanceId,
    );

    return {
      key_version: newVersion,
      public_key_fingerprint: derived.fingerprint,
    };
  }

  /**
   * Update general backup settings (enabled toggle, drive_path, retention toggle, schedule_hour, OAuth client).
   */
  async updateSettings(
    input: {
      enabled?: boolean;
      drive_path?: string;
      delete_older_than_month?: boolean;
      schedule_hour?: number;
      drive_client_id?: string;
      drive_client_secret?: string;
    },
    instanceId = "default",
  ): Promise<BackupPublicStatus> {
    const map = await this.getParamMap(instanceId);
    if (input.enabled === true) {
      const pubHex = map.get("public_key_hex") ?? "";
      if (!pubHex) {
        throw new Error("PASSWORD_REQUIRED: Set a backup password before enabling backup");
      }
    }
    if (input.enabled !== undefined) {
      await this.setParam("enabled", input.enabled ? "true" : "false", "Backup enabled", instanceId);
    }
    if (typeof input.drive_path === "string" && input.drive_path.trim()) {
      await this.setParam("drive_path", input.drive_path.trim(), "Google Drive folder path", instanceId);
    }
    if (input.delete_older_than_month !== undefined) {
      await this.setParam(
        "delete_older_than_month",
        input.delete_older_than_month ? "true" : "false",
        "Delete backups older than 30 days",
        instanceId,
      );
    }
    if (typeof input.schedule_hour === "number" && input.schedule_hour >= 0 && input.schedule_hour <= 23) {
      await this.setParam(
        "schedule_hour",
        String(Math.floor(input.schedule_hour)),
        "Daily schedule hour in Asia/Taipei",
        instanceId,
      );
    }
    if (typeof input.drive_client_id === "string") {
      await this.setParam("drive_client_id", input.drive_client_id.trim(), "Google OAuth client_id", instanceId);
    }
    if (typeof input.drive_client_secret === "string" && input.drive_client_secret.trim().length > 0) {
      await this.setParam(
        "drive_client_secret",
        input.drive_client_secret.trim(),
        "Google OAuth client_secret",
        instanceId,
      );
    }
    return this.getStatus(instanceId);
  }

  /**
   * Start Google OAuth 2.0 Device Flow.
   */
  async startGoogleDeviceFlow(
    input?: { client_id?: string; client_secret?: string },
    instanceId = "default",
  ): Promise<DeviceAuthSession> {
    if (input?.client_id || input?.client_secret) {
      await this.updateSettings(
        {
          drive_client_id: input.client_id,
          drive_client_secret: input.client_secret,
        },
        instanceId,
      );
    }
    const map = await this.getParamMap(instanceId);
    const clientId = map.get("drive_client_id") ?? "";
    const clientSecret = map.get("drive_client_secret") ?? "";
    if (!clientId || !clientSecret) {
      throw new Error("MISSING_OAUTH_CLIENT: Please save Google OAuth client_id and client_secret first");
    }
    const session = await startDeviceAuthorization(clientId, this.fetchImpl);
    this.pendingDeviceSession = {
      device_code: session.device_code,
      user_code: session.user_code,
      verification_url: session.verification_url,
      expires_at_ms: Date.now() + session.expires_in * 1000,
    };
    return session;
  }

  /**
   * Poll Google OAuth 2.0 Device Flow token endpoint and persist `drive_refresh_token` once authorized.
   */
  async pollGoogleDeviceFlow(
    deviceCode?: string,
    instanceId = "default",
  ): Promise<{ status: "pending" | "authorized" }> {
    const map = await this.getParamMap(instanceId);
    const clientId = map.get("drive_client_id") ?? "";
    const clientSecret = map.get("drive_client_secret") ?? "";
    const code = deviceCode?.trim() || this.pendingDeviceSession?.device_code || "";
    if (!clientId || !clientSecret || !code) {
      throw new Error("NO_ACTIVE_DEVICE_FLOW: Start Google authorization first");
    }
    const res = await pollDeviceToken(clientId, clientSecret, code, this.fetchImpl);
    if (res.status === "authorized" && res.tokens) {
      const refreshToken = res.tokens.refresh_token ?? "";
      if (!refreshToken) {
        throw new Error("NO_REFRESH_TOKEN: Google did not return a refresh_token");
      }
      await this.setParam("drive_refresh_token", refreshToken, "Google Drive OAuth refresh token", instanceId);
      this.pendingDeviceSession = null;
      return { status: "authorized" };
    }
    return { status: "pending" };
  }

  /**
   * Execute a full backup run now (or return the active promise if one is already in flight).
   */
  async runBackup(
    trigger: "manual" | "scheduled" | "catchup" = "manual",
    instanceId = "default",
  ): Promise<BackupRunRecord> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.executeBackupInternal(trigger, instanceId).finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  private async executeBackupInternal(
    trigger: "manual" | "scheduled" | "catchup",
    instanceId: string,
  ): Promise<BackupRunRecord> {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const map = await this.getParamMap(instanceId);
    const publicKeyHex = map.get("public_key_hex") ?? "";
    const saltHex = map.get("salt_hex") ?? "";
    const keyVersion = Number(map.get("key_version") ?? "0");
    let scryptParams = DEFAULT_SCRYPT_PARAMS;
    try {
      const rawScrypt = map.get("scrypt_params_json");
      if (rawScrypt) scryptParams = JSON.parse(rawScrypt) as ScryptParams;
    } catch {
      /* default */
    }

    const runningRecord: BackupRunRecord = {
      status: "running",
      started_at: startedAt,
      key_version: keyVersion,
      trigger,
    };
    await this.setParam("last_run_json", JSON.stringify(runningRecord), "Last backup run", instanceId);

    const runId = `run-${startedMs}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingDir = path.join(this.deps.stagingRootDir, runId);

    try {
      if (!publicKeyHex || !saltHex || keyVersion <= 0) {
        throw new Error("BACKUP_NOT_CONFIGURED: Missing backup encryption public key");
      }

      mkdirSync(stagingDir, { recursive: true });
      const coreStageDir = path.join(stagingDir, "core-data");
      mkdirSync(coreStageDir, { recursive: true });

      const { backup: sqliteBackup, DatabaseSync: DbSync } = requireNodeSqlite();

      // 1. Snapshot `vectors.db` via SQLite online backup API
      const vectorDb = this.deps.getVectorDb();
      const vectorsDest = path.join(coreStageDir, "vectors.db");
      if (vectorDb) {
        await sqliteBackup(vectorDb, vectorsDest);
        verifySqliteIntegrity(vectorsDest);
      } else {
        const liveVectorsPath = path.join(this.deps.coreDataDir, "vectors.db");
        if (existsSync(liveVectorsPath)) {
          const roDb = new DbSync(liveVectorsPath, { readOnly: true });
          try {
            await sqliteBackup(roDb, vectorsDest);
          } finally {
            roDb.close();
          }
          verifySqliteIntegrity(vectorsDest);
        }
      }

      // 2. Snapshot `core-data/metadata/*/metadata.db` (excluding `tdai_metadata_e2e-test`)
      const liveMetaRoot = path.join(this.deps.coreDataDir, "metadata");
      if (existsSync(liveMetaRoot)) {
        for (const sub of readdirSync(liveMetaRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name === "tdai_metadata_e2e-test") continue;
          const srcDbFile = path.join(liveMetaRoot, sub.name, "metadata.db");
          if (!existsSync(srcDbFile)) continue;
          const dstDbFile = path.join(coreStageDir, "metadata", sub.name, "metadata.db");
          mkdirSync(path.dirname(dstDbFile), { recursive: true });

          const metaStore = await this.deps.getMetadataStore(instanceId);
          const maybeSqlite = metaStore as unknown as {
            getRawDb?: () => DatabaseSync;
            getDbPath?: () => string;
          };
          if (
            maybeSqlite.getRawDb &&
            maybeSqlite.getDbPath &&
            path.resolve(maybeSqlite.getDbPath()) === path.resolve(srcDbFile)
          ) {
            await sqliteBackup(maybeSqlite.getRawDb(), dstDbFile);
          } else {
            const roMeta = new DbSync(srcDbFile, { readOnly: true });
            try {
              await sqliteBackup(roMeta, dstDbFile);
            } finally {
              roMeta.close();
            }
          }
          sanitizeAndCheckMetadataDb(dstDbFile);
        }
      }

      // 3. Copy core-data folders (`conversations`, `records`, `scene_blocks`, `profiles`, `instances`)
      for (const folder of CORE_DATA_COPY_DIRS) {
        const srcFolder = path.join(this.deps.coreDataDir, folder);
        if (existsSync(srcFolder)) {
          cpSync(srcFolder, path.join(coreStageDir, folder), { recursive: true });
        }
      }

      // 4. Ask `memory-hub` (Knowledge service) to snapshot `panel-data` (`knowledge.db` + wikis)
      if (this.deps.knowledgeInternalUrl) {
        const snapUrl = `${this.deps.knowledgeInternalUrl.replace(/\/+$/, "")}/v3/internal/backup/snapshot`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.deps.knowledgeServiceKey) {
          headers.Authorization = `Bearer ${this.deps.knowledgeServiceKey}`;
        }
        const snapRes = await this.fetchImpl(snapUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ subdir: runId }),
        });
        if (!snapRes.ok) {
          const errText = await snapRes.text().catch(() => "");
          throw new Error(`Knowledge snapshot endpoint failed (${snapRes.status}): ${errText}`);
        }
      }

      // 5. Copy `admin-key`, `agents.json`, and sanitized config files
      const hf = this.deps.hostFiles ?? {};
      if (hf.adminKeyPath && existsSync(hf.adminKeyPath)) {
        cpSync(hf.adminKeyPath, path.join(stagingDir, "admin-key"));
      }
      if (hf.agentsJsonPath && existsSync(hf.agentsJsonPath)) {
        cpSync(hf.agentsJsonPath, path.join(stagingDir, "agents.json"));
      }

      const configStageDir = path.join(stagingDir, "config");
      mkdirSync(configStageDir, { recursive: true });

      if (hf.globalEnvPath && existsSync(hf.globalEnvPath)) {
        const sanitized = sanitizeEnvContent(readFileSync(hf.globalEnvPath, "utf8"));
        const dst = path.join(configStageDir, "deploy", "global-images", ".env");
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, sanitized, "utf8");
      }
      if (hf.gatewayYamlPath && existsSync(hf.gatewayYamlPath)) {
        const sanitized = sanitizeGatewayYamlContent(readFileSync(hf.gatewayYamlPath, "utf8"));
        const dst = path.join(configStageDir, ".memory-core-config", "tdai-gateway.yaml");
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, sanitized, "utf8");
      }
      if (hf.claudeProxyEnvPath && existsSync(hf.claudeProxyEnvPath)) {
        const sanitized = sanitizeEnvContent(readFileSync(hf.claudeProxyEnvPath, "utf8"));
        const dst = path.join(configStageDir, "deploy", "claude-llm-proxy", ".env");
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, sanitized, "utf8");
      }
      if (hf.llmGatewayEnvPath && existsSync(hf.llmGatewayEnvPath)) {
        const sanitized = sanitizeEnvContent(readFileSync(hf.llmGatewayEnvPath, "utf8"));
        const dst = path.join(configStageDir, "llm-gateway", ".env");
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, sanitized, "utf8");
      }
      if (hf.llmGatewayConfigJsonPath && existsSync(hf.llmGatewayConfigJsonPath)) {
        const sanitized = sanitizeJsonConfigContent(readFileSync(hf.llmGatewayConfigJsonPath, "utf8"));
        const dst = path.join(configStageDir, "llm-gateway", "config.json");
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, sanitized, "utf8");
      }

      // 6. Secret scan across all staged config files and DB config tables
      const findings = scanStagingSnapshotForSecrets(stagingDir);
      if (findings.length > 0) {
        const detail = findings.map((f) => `${f.location} (${f.reason})`).join("; ");
        throw new Error(`SECRET_SCAN_FAILED: Potential unstripped token detected: ${detail}`);
      }

      // 7. Pack tar.gz and encrypt with stored public key
      const tarGz = createTarGzFromDirectory(stagingDir);
      const encrypted = encryptBackupPayload(tarGz, {
        publicKeyHex,
        saltHex,
        scryptParams,
        keyVersion,
      });

      const parts = formatTaipeiParts(startedMs);
      const fileName = `pmh-backup-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}-v${keyVersion}.tar.gz.age`;

      mkdirSync(this.deps.localBackupDir, { recursive: true });
      const localFilePath = path.join(this.deps.localBackupDir, fileName);
      writeFileSync(localFilePath, encrypted);

      // 8. Upload to Google Drive if authorized
      let driveFileId: string | undefined;
      const clientId = map.get("drive_client_id") ?? "";
      const clientSecret = map.get("drive_client_secret") ?? "";
      const refreshToken = map.get("drive_refresh_token") ?? "";
      const drivePath = map.get("drive_path") || DEFAULT_DRIVE_PATH;
      const deleteOlderThanMonth = map.get("delete_older_than_month") === "true";

      if (clientId && clientSecret && refreshToken) {
        const accessToken = await refreshAccessToken(
          clientId,
          clientSecret,
          refreshToken,
          this.fetchImpl,
        );
        const folderId = await ensureDriveFolderPath(accessToken, drivePath, this.fetchImpl);
        const uploaded = await uploadFileToDriveFolder(
          accessToken,
          folderId,
          fileName,
          encrypted,
          this.fetchImpl,
        );
        driveFileId = uploaded.fileId;

        if (deleteOlderThanMonth) {
          await pruneOldDriveBackups(accessToken, folderId, 30, startedMs, this.fetchImpl);
        }
      }

      // 9. Local 30-day retention cleanup if enabled
      if (deleteOlderThanMonth) {
        this.pruneLocalBackups(30, startedMs);
      }

      const record: BackupRunRecord = {
        status: "success",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        file_name: fileName,
        size_bytes: encrypted.length,
        key_version: keyVersion,
        ...(driveFileId ? { drive_file_id: driveFileId } : {}),
        trigger,
      };
      await this.setParam("last_run_json", JSON.stringify(record), "Last backup run", instanceId);
      await this.setParam("last_success_date", parts.dateKey, "Last successful Taipei date", instanceId);
      this.deps.logger?.info(`[backup] completed ${fileName} (${encrypted.length} bytes, trigger=${trigger})`);
      return record;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedRecord: BackupRunRecord = {
        status: "failed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        key_version: keyVersion,
        error: msg,
        trigger,
      };
      await this.setParam("last_run_json", JSON.stringify(failedRecord), "Last backup run", instanceId).catch(
        () => {},
      );
      this.deps.logger?.error(`[backup] failed (trigger=${trigger}): ${msg}`);
      return failedRecord;
    } finally {
      // Always clean up staging directory so unencrypted snapshots never linger on disk
      try {
        if (existsSync(stagingDir)) {
          rmSync(stagingDir, { recursive: true, force: true });
        }
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  /**
   * Prune local backup files in `localBackupDir` older than `maxAgeDays` that strictly match
   * `BACKUP_FILENAME_REGEX`. Leaves any other files untouched.
   */
  pruneLocalBackups(maxAgeDays = 30, nowMs = Date.now()): string[] {
    if (!existsSync(this.deps.localBackupDir)) return [];
    const cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    for (const entry of readdirSync(this.deps.localBackupDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!BACKUP_FILENAME_REGEX.test(entry.name)) continue;
      const fullPath = path.join(this.deps.localBackupDir, entry.name);
      const parsedMs = parseBackupFilenameDateMs(entry.name);
      const fileMs = parsedMs ?? statSync(fullPath).mtimeMs;
      if (fileMs < cutoffMs) {
        rmSync(fullPath, { force: true });
        deleted.push(entry.name);
      }
    }
    return deleted;
  }

  /**
   * Check whether a scheduled or catch-up run is due right now (in `Asia/Taipei` timezone).
   * Called on startup and every 60 seconds by the scheduler timer.
   */
  async checkAndRunScheduled(nowMs = Date.now(), instanceId = "default"): Promise<BackupRunRecord | null> {
    const map = await this.getParamMap(instanceId);
    if (map.get("enabled") !== "true") return null;
    const pubHex = map.get("public_key_hex") ?? "";
    if (!pubHex) return null;

    const scheduleHour = Number(map.get("schedule_hour") ?? String(DEFAULT_SCHEDULE_HOUR));
    const parts = formatTaipeiParts(nowMs);
    const currentHour = Number(parts.hour);
    const lastSuccessDate = map.get("last_success_date") ?? "";
    const lastAttemptDate = map.get("last_scheduled_attempt_date") ?? "";

    // Catch-up / daily rule (Design Doc §2, §4):
    // If today (in Asia/Taipei) has not succeeded yet AND current hour >= scheduleHour,
    // and we haven't already attempted the automatic daily run today, run once now.
    if (currentHour >= scheduleHour && lastSuccessDate !== parts.dateKey && lastAttemptDate !== parts.dateKey) {
      await this.setParam(
        "last_scheduled_attempt_date",
        parts.dateKey,
        "Last scheduled/catch-up attempt Taipei date",
        instanceId,
      );
      const trigger = currentHour > scheduleHour ? "catchup" : "scheduled";
      return this.runBackup(trigger, instanceId);
    }
    return null;
  }

  startScheduler(intervalMs = 60_000): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.checkAndRunScheduled();
      } catch (err) {
        this.deps.logger?.warn(
          `[backup] scheduler tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, intervalMs);
        this.timer.unref?.();
      }
    };
    // Initial check 10 seconds after startup for catch-up
    this.timer = setTimeout(tick, Math.min(intervalMs, 10_000));
    this.timer.unref?.();
  }

  stopScheduler(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
