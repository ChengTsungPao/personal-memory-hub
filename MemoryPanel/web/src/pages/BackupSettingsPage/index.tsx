/**
 * BackupSettingsPage — Memory Hub 備份設定與管理頁（Design Doc §9）。
 *
 * 功能涵蓋：
 *   1. 啟用備份開關：未完成前置條件時引導使用者依序完成：
 *      設定密碼（兩次，至少 12 字元）→ 填寫 Google OAuth 用戶端 → Google 裝置授權 → 選擇 Drive 路徑 → 開啟排程。
 *   2. 備份狀態與手動觸發（「現在備份」）：上次成功時間、大小、密碼版本、失敗原因、下次排程時間。
 *   3. 更改密碼：輸入舊密碼 → 新密碼兩次；提醒忘記密碼無法還原、舊備份仍需舊密碼。
 *   4. 密碼修改紀錄（唯讀稽核表）：列出設定/更改事件、時間、新舊版本號、操作者、公鑰指紋（不含密碼）。
 *   5. 保留策略（「刪除超過一個月的」開關）與每日排程時間設定。
 *   6. 還原說明：顯示完整還原指令與目前所需密碼版本。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Copy,
  Input,
  Switch,
  Tag,
  Text,
} from 'tea-component';
import {
  backupApi,
  type BackupStatus,
  type DeviceAuthSession,
} from '@/lib/api/backup';
import { tea } from '@/lib/tea-bridge';
import '@/pages/GuidePage/style.css';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '尚無紀錄';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function BackupSettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Password form
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Drive & OAuth form
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [drivePath, setDrivePath] = useState('backup/personal_memory_hub/');
  const [scheduleHour, setScheduleHour] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  // Device flow state
  const [deviceSession, setDeviceSession] = useState<DeviceAuthSession | null>(null);
  const [startingAuth, setStartingAuth] = useState(false);
  const [pollingAuth, setPollingAuth] = useState(false);

  // Manual backup run
  const [runningBackup, setRunningBackup] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await backupApi.status();
      setStatus(s);
      setClientId((prev) => prev || s.drive_client_id || '');
      setDrivePath(s.drive_path || 'backup/personal_memory_hub/');
      setScheduleHour(s.schedule_hour ?? 4);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleSavePassword() {
    if (newPassword.length < 12) {
      tea.notify.error('密碼長度至少需要 12 個字元');
      return;
    }
    if (newPassword !== confirmPassword) {
      tea.notify.error('兩次輸入的新密碼不一致');
      return;
    }
    if (status?.has_password && !oldPassword) {
      tea.notify.error('更改密碼時必須輸入舊密碼');
      return;
    }

    setSavingPassword(true);
    try {
      const res = await backupApi.setOrChangePassword({
        ...(status?.has_password ? { old_password: oldPassword } : {}),
        new_password: newPassword,
        confirm_password: confirmPassword,
      });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      tea.notify.success(`備份密碼已更新（版本 v${res.key_version}）`);
      await loadStatus();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleToggleEnabled(next: boolean) {
    if (next && !status?.has_password) {
      tea.notify.warning('請先完成步驟 1：設定備份加密密碼（輸入兩次）');
      return;
    }
    setSavingSettings(true);
    try {
      const updated = await backupApi.updateSettings({ enabled: next });
      setStatus(updated);
      window.dispatchEvent(new CustomEvent('pmh-backup-status-changed'));
      tea.notify.success(next ? '已開啟每日自動備份' : '已關閉自動備份');
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleToggleRetention(next: boolean) {
    setSavingSettings(true);
    try {
      const updated = await backupApi.updateSettings({ delete_older_than_month: next });
      setStatus(updated);
      tea.notify.success(next ? '已開啟自動刪除超過一個月的備份' : '已改為保留全部備份');
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleSaveDriveSettings() {
    setSavingSettings(true);
    try {
      const updated = await backupApi.updateSettings({
        drive_path: drivePath.trim() || 'backup/personal_memory_hub/',
        schedule_hour: scheduleHour,
        drive_client_id: clientId.trim(),
        ...(clientSecret.trim() ? { drive_client_secret: clientSecret.trim() } : {}),
      });
      setStatus(updated);
      setClientSecret('');
      tea.notify.success('備份路徑與 OAuth 設定已儲存');
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleStartGoogleAuth() {
    setStartingAuth(true);
    try {
      const session = await backupApi.startGoogleAuth({
        ...(clientId.trim() ? { client_id: clientId.trim() } : {}),
        ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
      });
      setDeviceSession(session);
      setClientSecret('');
      await loadStatus();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingAuth(false);
    }
  }

  async function handlePollGoogleAuth() {
    if (!deviceSession) return;
    setPollingAuth(true);
    try {
      const res = await backupApi.pollGoogleAuth(deviceSession.device_code);
      if (res.status === 'authorized') {
        setDeviceSession(null);
        tea.notify.success('Google Drive 授權成功！');
        await loadStatus();
      } else {
        tea.notify.warning('尚未完成瀏覽器授權，請在 Google 頁面輸入代碼並同意後再試一次');
      }
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPollingAuth(false);
    }
  }

  async function handleRunBackupNow() {
    if (!status?.has_password) {
      tea.notify.warning('請先設定備份密碼');
      return;
    }
    setRunningBackup(true);
    try {
      const run = await backupApi.runNow();
      await loadStatus();
      window.dispatchEvent(new CustomEvent('pmh-backup-status-changed'));
      if (run.status === 'success') {
        tea.notify.success(`備份完成：${run.file_name} (${formatBytes(run.size_bytes)})`);
      } else {
        tea.notify.error(`備份失敗：${run.error || '未知錯誤'}`);
      }
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningBackup(false);
    }
  }

  const keyVer = status?.key_version || 1;
  const sampleFile = status?.last_run?.file_name || `pmh-backup-YYYYMMDD-HHmm-v${keyVer}.tar.gz.age`;
  const restoreCmd = `node --import tsx MemoryCore/scripts/restore-backup.ts ~/.personal-memory-hub/backups/${sampleFile} ./restored-memory-hub`;

  const triggerLabel =
    status?.last_run?.trigger === 'manual'
      ? '手動觸發'
      : status?.last_run?.trigger === 'scheduled'
        ? '每日排程'
        : status?.last_run?.trigger === 'catchup'
          ? '開機補跑'
          : '';

  return (
    <div className="guide-page">
      <header className="guide-titlebar">
        <div>
          <button type="button" className="guide-back" onClick={() => navigate(-1)}>
            ← {t('guide.back', '返回')}
          </button>
          <h1>自動加密備份 (Google Drive)</h1>
          <p>
            每天自動對完整記憶（SQLite 一致快照 + 對話與 Wiki）去除個人/第三方 Token 後以 X25519 公鑰加密並上傳 Google Drive
          </p>
        </div>
        <span className="guide-brand">{t('guide.brand', 'Memory Hub')}</span>
      </header>

      {error && (
        <Alert type="error" style={{ marginTop: 16 }}>
          {error}
        </Alert>
      )}

      {status?.last_run?.status === 'failed' && (
        <Alert type="error" style={{ marginTop: 16 }}>
          <strong>最近一次備份失敗（{formatDateTime(status.last_run.finished_at)}）：</strong>{' '}
          {status.last_run.error}
        </Alert>
      )}

      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 1. 總開關與狀態面板 */}
        <Card>
          <Card.Body title="備份狀態與開關">
            {/* 主控制列：左邊標題+狀態標籤+說明，右邊 Switch 與「現在備份」按鈕 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 16,
                padding: '14px 16px',
                borderRadius: 8,
                border: '1px solid var(--tea-color-border-primary-default)',
                background: status?.enabled
                  ? 'var(--tea-color-bg-brand-lighten-default)'
                  : 'var(--tea-color-bg-secondary-default)',
                transition: 'background-color 0.15s',
              }}
            >
              <div style={{ minWidth: 240, flex: '1 1 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: 600 }}>
                    每日自動排程備份
                  </Text>
                  <Tag theme={status?.enabled ? 'success' : 'default'} variant="soft" size="sm">
                    {status?.enabled ? '已啟用' : '已關閉'}
                  </Tag>
                  {status?.has_password ? (
                    <Tag theme="primary" variant="soft" size="sm">
                      密碼版本 v{status.key_version}（指紋 {status.public_key_fingerprint}）
                    </Tag>
                  ) : (
                    <Tag theme="warning" variant="soft" size="sm">
                      尚未設定密碼
                    </Tag>
                  )}
                  <Tag theme={status?.drive_authorized ? 'success' : 'default'} variant="soft" size="sm">
                    {status?.drive_authorized ? 'Google Drive 已連結' : '僅本機備份（未授權 Drive）'}
                  </Tag>
                </div>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 6, display: 'block', lineHeight: '18px' }}>
                  開啟後將於每日 {String(status?.schedule_hour ?? 4).padStart(2, '0')}:00（{status?.timezone || 'Asia/Taipei'}）自動執行快照、加密與上傳；若錯過排程時間將於容器啟動時自動補跑一次。
                </Text>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text theme="weak" style={{ fontSize: 12 }}>
                    自動排程
                  </Text>
                  <Switch
                    value={Boolean(status?.enabled)}
                    disabled={loading || savingSettings}
                    onChange={(v) => void handleToggleEnabled(v)}
                  />
                </div>
                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: 'var(--tea-color-border-primary-default)',
                  }}
                />
                <Button
                  type="primary"
                  disabled={loading || runningBackup || !status?.has_password}
                  onClick={() => void handleRunBackupNow()}
                >
                  {runningBackup ? '正在備份中…' : '現在備份'}
                </Button>
              </div>
            </div>

            {/* 4 個獨立指標小卡 */}
            <div
              style={{
                marginTop: 14,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
              }}
            >
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--tea-color-border-primary-default)',
                  background: 'var(--tea-color-bg-primary-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <Text theme="weak" style={{ fontSize: 12 }}>
                  上次備份狀態
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
                  {!status?.last_run ? (
                    <Text style={{ fontSize: 14, fontWeight: 600 }}>尚無紀錄</Text>
                  ) : (
                    <>
                      <Tag
                        theme={
                          status.last_run.status === 'success'
                            ? 'success'
                            : status.last_run.status === 'running'
                              ? 'warning'
                              : 'danger'
                        }
                        variant="soft"
                        size="sm"
                      >
                        {status.last_run.status === 'success'
                          ? '成功'
                          : status.last_run.status === 'running'
                            ? '執行中'
                            : '失敗'}
                      </Tag>
                      {triggerLabel && (
                        <Text theme="weak" style={{ fontSize: 12 }}>
                          {triggerLabel}
                        </Text>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--tea-color-border-primary-default)',
                  background: 'var(--tea-color-bg-primary-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <Text theme="weak" style={{ fontSize: 12 }}>
                  上次完成時間
                </Text>
                <Text style={{ fontSize: 14, fontWeight: 600, lineHeight: '24px' }}>
                  {formatDateTime(status?.last_run?.finished_at)}
                </Text>
              </div>

              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--tea-color-border-primary-default)',
                  background: 'var(--tea-color-bg-primary-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <Text theme="weak" style={{ fontSize: 12 }}>
                  下次排程時間 ({status?.timezone || 'Asia/Taipei'})
                </Text>
                <Text style={{ fontSize: 14, fontWeight: 600, lineHeight: '24px' }}>
                  {status?.enabled ? formatDateTime(status?.next_scheduled_at) : '未啟用自動排程'}
                </Text>
              </div>

              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--tea-color-border-primary-default)',
                  background: 'var(--tea-color-bg-primary-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <Text theme="weak" style={{ fontSize: 12 }}>
                    最近備份檔案
                  </Text>
                  {status?.last_run?.size_bytes !== undefined && (
                    <Tag theme="default" variant="soft" size="sm">
                      {formatBytes(status.last_run.size_bytes)}
                    </Tag>
                  )}
                </div>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: '20px',
                    wordBreak: 'break-all',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  {status?.last_run?.file_name || '尚無備份檔案'}
                </Text>
              </div>
            </div>
          </Card.Body>
        </Card>

        {/* 2. 設定或更改加密密碼 */}
        <Card>
          <Card.Body title={status?.has_password ? `更改備份加密密碼（目前版本 v${status.key_version}）` : '步驟 1：設定備份加密密碼'}>
            <Alert type="warning" style={{ marginBottom: 14 }}>
              伺服器<strong>不會儲存您的密碼或私鑰</strong>（僅儲存 scrypt 鹽值與推導出的 X25519 公鑰）。
              <strong>忘記密碼等於無法還原任何備份，沒有後門。</strong>
              更改密碼後版本號會加一，舊備份仍須使用當時對應版本的舊密碼解開。
            </Alert>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              {status?.has_password && (
                <div>
                  <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>目前舊密碼</Text>
                  <Input
                    type="password"
                    size="full"
                    placeholder="輸入舊密碼以驗證身分"
                    value={oldPassword}
                    onChange={(v) => setOldPassword(v)}
                  />
                </div>
              )}
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>
                  {status?.has_password ? '新密碼（至少 12 字元）' : '備份密碼（至少 12 字元）'}
                </Text>
                <Input
                  type="password"
                  size="full"
                  placeholder="請輸入至少 12 字元的高強度密碼"
                  value={newPassword}
                  onChange={(v) => setNewPassword(v)}
                />
              </div>
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>再次輸入密碼確認</Text>
                <Input
                  type="password"
                  size="full"
                  placeholder="再次輸入相同密碼"
                  value={confirmPassword}
                  onChange={(v) => setConfirmPassword(v)}
                />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <Button
                type="primary"
                disabled={savingPassword || !newPassword || !confirmPassword}
                onClick={() => void handleSavePassword()}
              >
                {savingPassword ? '計算公鑰並儲存中…' : status?.has_password ? '驗證舊密碼並更新' : '設定備份密碼'}
              </Button>
            </div>
          </Card.Body>
        </Card>

        {/* 3. Google Drive 授權、路徑與保留策略 */}
        <Card>
          <Card.Body title="步驟 2：Google Drive 裝置授權、路徑與保留策略">
            <Text theme="weak" style={{ display: 'block', marginBottom: 14, fontSize: 12, lineHeight: '18px' }}>
              請先在 Google Cloud Console 建立一個類型為「電視與受限輸入裝置 (TVs and Limited Input devices)」的 OAuth 2.0 用戶端，
              並啟用 Google Drive API。授權範圍僅使用 <code>drive.file</code>（只能存取本程式建立的備份檔）。
            </Text>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>Google OAuth Client ID</Text>
                <Input
                  size="full"
                  placeholder="xxxx.apps.googleusercontent.com"
                  value={clientId}
                  onChange={(v) => setClientId(v)}
                />
              </div>
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>
                  Google OAuth Client Secret {status?.drive_has_client_secret ? '（已儲存，留空則保留原值）' : ''}
                </Text>
                <Input
                  type="password"
                  size="full"
                  placeholder={status?.drive_has_client_secret ? '已設定（如需更新請重新輸入）' : 'GOCSPX-...'}
                  value={clientSecret}
                  onChange={(v) => setClientSecret(v)}
                />
              </div>
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>Google Drive 備份資料夾路徑</Text>
                <Input
                  size="full"
                  placeholder="backup/personal_memory_hub/"
                  value={drivePath}
                  onChange={(v) => setDrivePath(v)}
                />
              </div>
              <div>
                <Text theme="label" style={{ display: 'block', marginBottom: 6 }}>每日排程時間（UTC+8 小時，0–23）</Text>
                <Input
                  size="full"
                  value={String(scheduleHour)}
                  onChange={(v) => {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0 && n <= 23) setScheduleHour(Math.floor(n));
                  }}
                />
              </div>
            </div>

            {/* 保留策略獨立區塊 */}
            <div
              style={{
                marginTop: 14,
                padding: '12px 14px',
                borderRadius: 8,
                border: '1px solid var(--tea-color-border-primary-default)',
                background: 'var(--tea-color-bg-secondary-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div>
                <Text style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  自動清理超過 30 天的舊備份
                </Text>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                  同時套用於本機與 Google Drive 備份資料夾，僅刪除符合 <code>pmh-backup-*.tar.gz.age</code> 命名規則的備份檔。
                </Text>
              </div>
              <Switch
                value={Boolean(status?.delete_older_than_month)}
                disabled={savingSettings}
                onChange={(v) => void handleToggleRetention(v)}
              />
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Button
                type="weak"
                disabled={savingSettings}
                onClick={() => void handleSaveDriveSettings()}
              >
                儲存路徑與排程設定
              </Button>
              <Button
                type="primary"
                disabled={startingAuth || (!clientId.trim() && !status?.drive_client_id)}
                onClick={() => void handleStartGoogleAuth()}
              >
                {startingAuth ? '正在取得授權碼…' : status?.drive_authorized ? '重新連結 Google Drive' : '開始 Google 裝置授權'}
              </Button>
            </div>

            {deviceSession && (
              <div
                style={{
                  marginTop: 16,
                  padding: 14,
                  borderRadius: 8,
                  border: '1px solid var(--tea-color-border-primary-default)',
                  background: 'var(--tea-color-bg-brand-lighten-default)',
                }}
              >
                <Text style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>
                  請在瀏覽器開啟下方網址，並輸入裝置授權碼：
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                  <Tag theme="primary">授權碼：{deviceSession.user_code}</Tag>
                  <Copy text={deviceSession.user_code} />
                  <a
                    href={deviceSession.verification_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: 'underline', fontWeight: 600 }}
                  >
                    開啟 {deviceSession.verification_url} ↗
                  </a>
                </div>
                <Button
                  type="primary"
                  disabled={pollingAuth}
                  onClick={() => void handlePollGoogleAuth()}
                >
                  {pollingAuth ? '正在確認授權狀態…' : '我已在瀏覽器完成同意，點此完成綁定'}
                </Button>
              </div>
            )}
          </Card.Body>
        </Card>

        {/* 4. 還原說明 */}
        <Card>
          <Card.Body title="還原說明（支援 Windows 長路徑）">
            <Text theme="weak" style={{ display: 'block', marginBottom: 8, fontSize: 12, lineHeight: '18px' }}>
              備份檔使用 X25519 + AES-256-GCM 加密（檔頭內含 scrypt 鹽值與參數，即使本機資料庫完全遺失也能獨立解開）。
              請注意檔名上的版本號（例如 <code>-v{keyVer}</code>），還原時必須輸入對應版本的密碼：
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input readonly size="full" value={restoreCmd} />
              <Copy text={restoreCmd} />
            </div>
          </Card.Body>
        </Card>

        {/* 5. 密碼設定與更改紀錄（只增不改，不含密碼） */}
        <Card>
          <Card.Body title="密碼設定與更改紀錄（Audit Log）">
            {!status?.audit_log || status.audit_log.length === 0 ? (
              <Text theme="weak">尚無密碼設定紀錄</Text>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--tea-color-border-primary-default)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 10px' }}>時間</th>
                      <th style={{ padding: '8px 10px' }}>事件類型</th>
                      <th style={{ padding: '8px 10px' }}>版本變更</th>
                      <th style={{ padding: '8px 10px' }}>操作使用者</th>
                      <th style={{ padding: '8px 10px' }}>公鑰指紋 (SHA-256)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...status.audit_log].reverse().map((entry, idx) => (
                      <tr
                        key={`${entry.at}-${idx}`}
                        style={{ borderBottom: '1px solid var(--tea-color-border-primary-default)' }}
                      >
                        <td style={{ padding: '8px 10px' }}>{formatDateTime(entry.at)}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <Tag theme={entry.event === 'set' ? 'success' : 'warning'} variant="soft" size="sm">
                            {entry.event === 'set' ? '初次設定' : '更改密碼'}
                          </Tag>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          {entry.old_version ? `v${entry.old_version} → v${entry.new_version}` : `v${entry.new_version}`}
                        </td>
                        <td style={{ padding: '8px 10px' }}><code>{entry.user_id}</code></td>
                        <td style={{ padding: '8px 10px' }}><code>{entry.public_key_fingerprint}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card.Body>
        </Card>
      </div>
    </div>
  );
}
