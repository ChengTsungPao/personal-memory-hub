/**
 * api/backup.ts — Memory Hub 備份設定與管理 API（/api/v1/backup/* → MemoryCore /v3/backup/*）。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

export interface PasswordAuditEntry {
  event: 'set' | 'change';
  at: string;
  old_version: number | null;
  new_version: number;
  user_id: string;
  public_key_fingerprint: string;
}

export interface BackupRunRecord {
  status: 'success' | 'failed' | 'running';
  started_at: string;
  finished_at?: string;
  file_name?: string;
  size_bytes?: number;
  key_version?: number;
  drive_file_id?: string;
  error?: string;
  trigger: 'manual' | 'scheduled' | 'catchup';
}

export interface BackupStatus {
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

export interface DeviceAuthSession {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

const BACKUP_PREFIX = '/api/v1/backup';

async function backupCall<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `${BACKUP_PREFIX}/${endpoint}`,
    body,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const backupApi = {
  status: () => backupCall<BackupStatus>('status'),

  setOrChangePassword: (params: {
    old_password?: string;
    new_password: string;
    confirm_password: string;
  }) =>
    backupCall<{ key_version: number; public_key_fingerprint: string }>('password', params),

  updateSettings: (params: {
    enabled?: boolean;
    drive_path?: string;
    delete_older_than_month?: boolean;
    schedule_hour?: number;
    drive_client_id?: string;
    drive_client_secret?: string;
  }) => backupCall<BackupStatus>('settings', params),

  startGoogleAuth: (params?: { client_id?: string; client_secret?: string }) =>
    backupCall<DeviceAuthSession>('google-auth/start', params ?? {}),

  pollGoogleAuth: (deviceCode?: string) =>
    backupCall<{ status: 'pending' | 'authorized' }>(
      'google-auth/poll',
      deviceCode ? { device_code: deviceCode } : {},
    ),

  runNow: () => backupCall<BackupRunRecord>('run'),
};
