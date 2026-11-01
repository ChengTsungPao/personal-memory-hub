import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreBackupArchive } from '../../scripts/restore-backup.js';
import { SqliteMetadataStore } from '../metadata/store/sqlite-adapter.js';
import { decryptBackupPayload } from './crypto.js';
import { pruneOldDriveBackups } from './drive.js';
import { BackupEngine, type BackupEngineDeps } from './engine.js';
import { scanStagingSnapshotForSecrets } from './sanitize.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Memory Hub Backup System (Design Doc v1.1)', () => {
  let rootDir: string;
  let coreDataDir: string;
  let stagingRootDir: string;
  let localBackupDir: string;
  let hostConfigDir: string;
  let metaStore: SqliteMetadataStore;

  beforeEach(() => {
    rootDir = createTempDir('pmh-backup-test-');
    coreDataDir = path.join(rootDir, 'core-data');
    stagingRootDir = path.join(rootDir, 'staging');
    localBackupDir = path.join(coreDataDir, 'backups');
    hostConfigDir = path.join(rootDir, 'host-config');

    fs.mkdirSync(coreDataDir, { recursive: true });
    fs.mkdirSync(stagingRootDir, { recursive: true });
    fs.mkdirSync(localBackupDir, { recursive: true });
    fs.mkdirSync(hostConfigDir, { recursive: true });

    const metaDbDir = path.join(coreDataDir, 'metadata', 'tdai_metadata_default');
    fs.mkdirSync(metaDbDir, { recursive: true });
    metaStore = new SqliteMetadataStore(path.join(metaDbDir, 'metadata.db'));
    metaStore.init();
  });

  afterEach(() => {
    try {
      metaStore.close();
    } catch {
      // ignore
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function createEngine(overrides?: Partial<BackupEngineDeps>): BackupEngine {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v3/internal/backup/snapshot')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { subdir?: string };
        const subdir = body.subdir ?? 'default';
        const targetDir = path.join(stagingRootDir, subdir);
        const panelDir = path.join(targetDir, 'panel-data');
        const panelWikiDir = path.join(panelDir, 'wiki', 'ws-1');
        fs.mkdirSync(panelWikiDir, { recursive: true });

        const kdbPath = path.join(panelDir, 'knowledge.db');
        const kdb = new DatabaseSync(kdbPath);
        kdb.exec(`
          CREATE TABLE knowledge_connector (id TEXT PRIMARY KEY, token TEXT);
          CREATE TABLE llm_binding (scope_key TEXT PRIMARY KEY, api_key TEXT);
          INSERT INTO knowledge_connector (id, token) VALUES ('conn-1', '');
          INSERT INTO llm_binding (scope_key, api_key) VALUES ('default', '');
        `);
        kdb.close();

        fs.writeFileSync(path.join(panelWikiDir, 'note.md'), '# Wiki Note\nHello world\n', 'utf8');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    return new BackupEngine({
      coreDataDir,
      stagingRootDir,
      localBackupDir,
      getVectorDb: () => null,
      getMetadataStore: async () => metaStore,
      knowledgeInternalUrl: 'http://memory-hub:8424',
      knowledgeServiceKey: 'ks-svc-test-key',
      hostFiles: {
        adminKeyPath: path.join(hostConfigDir, 'admin-key'),
        agentsJsonPath: path.join(hostConfigDir, 'agents.json'),
        globalEnvPath: path.join(hostConfigDir, 'global.env'),
        gatewayYamlPath: path.join(hostConfigDir, 'tdai-gateway.yaml'),
        claudeProxyEnvPath: path.join(hostConfigDir, 'claude-proxy.env'),
        llmGatewayEnvPath: path.join(hostConfigDir, 'llm-gateway.env'),
        llmGatewayConfigJsonPath: path.join(hostConfigDir, 'llm-gateway-config.json'),
      },
      fetchImpl: mockFetch,
      ...overrides,
    });
  }

  it('1. strips all external tokens from configs and SQLite DBs, keeps sk-mem- keys, and blocks leaked secrets', async () => {
    const fakeOpenRouterKey = 'sk-or-v1-1111222233334444555566667777888899990000aaaabbbb';
    const fakeClaudeToken = 'sk-ant-oat01-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff';
    const fakeLlmKey = 'sk-proj-fakeLlmKey1234567890abcdefghijklmnop';
    const fakeUpstreamKey = 'sk-proj-upstreamSecret9876543210abcdefghijklm';
    const preservedAdminKey = 'sk-mem-AdminKeyPreserved1234567890123456';

    // Write host config files containing fake secrets
    fs.writeFileSync(path.join(hostConfigDir, 'admin-key'), preservedAdminKey, 'utf8');
    fs.writeFileSync(
      path.join(hostConfigDir, 'agents.json'),
      JSON.stringify({ agents: ['claude', 'cursor'] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(hostConfigDir, 'global.env'),
      [
        `MEMORY_LLM_API_KEY=${fakeLlmKey}`,
        `MEMORY_EMBEDDING_API_KEY="sk-proj-embedSecret1234567890abcdefghijkl"`,
        `PROXY_UPSTREAM_API_KEY='${fakeUpstreamKey}'`,
        `KNOWLEDGE_SERVICE_KEY=ks-svc-internal-allowed`,
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(hostConfigDir, 'claude-proxy.env'),
      `CLAUDE_CODE_OAUTH_TOKEN=${fakeClaudeToken}\nPORT=8082\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(hostConfigDir, 'llm-gateway.env'),
      `OPENROUTER_API_KEY=${fakeOpenRouterKey}\nAPI_KEY=${fakeLlmKey}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(hostConfigDir, 'llm-gateway-config.json'),
      JSON.stringify({
        providers: {
          openrouter: { api_key: fakeOpenRouterKey, model: 'gpt-4o' },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(hostConfigDir, 'tdai-gateway.yaml'),
      `llm:\n  baseUrl: "http://localhost:8000/v1"\n  apiKey: "${fakeLlmKey}"\n`,
      'utf8',
    );

    // Seed metadata.db with user password, upstream api_key, and sk-mem- user key
    const rawMeta = metaStore.getRawDb();
    rawMeta
      .prepare(
        `INSERT INTO meta_users (user_id, password, auth_provider, external_id, username, status, user_type, created_at, updated_at)
         VALUES ('u-admin', 'scrypt$secretpasswordhash', 'local', 'admin', 'admin', 'active', 'system_admin', datetime('now'), datetime('now'))`,
      )
      .run();
    rawMeta
      .prepare(
        `INSERT INTO meta_user_keys (key_id, user_id, key_value, name, status, created_at)
         VALUES ('k-1', 'u-admin', ?, 'default', 'active', datetime('now'))`,
      )
      .run(preservedAdminKey);
    rawMeta
      .prepare(
        `INSERT INTO meta_instance_upstream_config (agent_source, type, mode, base_url, api_key, model_id, description, created_at, updated_at)
         VALUES ('default', 'conversation', 'custom_unified', 'https://api.openai.com/v1', ?, 'gpt-4o', 'test', datetime('now'), datetime('now'))`,
      )
      .run(fakeUpstreamKey);

    // Seed vectors.db with a conversation that mentions a fake sk-proj- string and 64-hex hash
    // to verify user memory content does NOT cause false positives in the secret scanner
    const vecDb = new DatabaseSync(path.join(coreDataDir, 'vectors.db'));
    vecDb.exec(`
      CREATE TABLE l0_sessions (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO l0_sessions (id, content) VALUES (
        'sess-1',
        'User pasted example key sk-proj-exampleInConversation1234567890abcdef and commit a3f5c8d9e0b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7'
      );
    `);
    vecDb.close();

    const engine = createEngine();
    await engine.setOrChangePassword({
      userId: 'u-admin',
      newPassword: 'correct-horse-battery-staple',
      confirmPassword: 'correct-horse-battery-staple',
    });
    // Store Google OAuth client_secret in meta_config_params to verify it gets stripped in snapshot
    await metaStore.upsertConfigParam({
      scope: 'global',
      user_id: null,
      module: 'backup',
      param_name: 'drive_client_secret',
      param_value: 'GOCSPX-FakeClientSecret1234567890',
      description: 'test secret',
    });

    const record = await engine.runBackup('manual');
    expect(record.status).toBe('success');
    expect(record.file_name).toMatch(/^pmh-backup-\d{8}-\d{4}-v1\.tar\.gz\.age$/);

    // Restore and inspect the decrypted archive
    const backupFilePath = path.join(localBackupDir, record.file_name!);
    const restoreDir = path.join(rootDir, 'restored-check');
    const restoreResult = await restoreBackupArchive({
      archivePath: backupFilePath,
      password: 'correct-horse-battery-staple',
      targetDir: restoreDir,
    });
    expect(restoreResult.verifiedDbs.length).toBeGreaterThanOrEqual(3);

    // Ensure preserved admin key is still intact
    expect(fs.readFileSync(path.join(restoreDir, 'admin-key'), 'utf8')).toBe(preservedAdminKey);

    // Ensure none of the stripped secrets exist anywhere in restored config files or metadata.db
    const restoredGlobalEnv = fs.readFileSync(
      path.join(restoreDir, 'config', 'deploy', 'global-images', '.env'),
      'utf8',
    );
    expect(restoredGlobalEnv).not.toContain(fakeLlmKey);
    expect(restoredGlobalEnv).not.toContain(fakeUpstreamKey);

    const restoredClaudeEnv = fs.readFileSync(
      path.join(restoreDir, 'config', 'deploy', 'claude-llm-proxy', '.env'),
      'utf8',
    );
    expect(restoredClaudeEnv).not.toContain(fakeClaudeToken);

    const restoredGatewayJson = fs.readFileSync(
      path.join(restoreDir, 'config', 'llm-gateway', 'config.json'),
      'utf8',
    );
    expect(restoredGatewayJson).not.toContain(fakeOpenRouterKey);

    const restoredMetaDb = new DatabaseSync(
      path.join(restoreDir, 'core-data', 'metadata', 'tdai_metadata_default', 'metadata.db'),
      { readOnly: true },
    );
    const upstreamRow = restoredMetaDb
      .prepare('SELECT api_key FROM meta_instance_upstream_config LIMIT 1')
      .get() as { api_key: string };
    expect(upstreamRow.api_key).toBe('');

    const userRow = restoredMetaDb
      .prepare('SELECT password FROM meta_users WHERE username = ?')
      .get('admin') as { password: string | null };
    expect(userRow.password).toBeNull();

    const keyRow = restoredMetaDb
      .prepare('SELECT key_value FROM meta_user_keys LIMIT 1')
      .get() as { key_value: string };
    expect(keyRow.key_value).toBe(preservedAdminKey);

    const secretParamRows = restoredMetaDb
      .prepare(
        "SELECT param_value FROM meta_config_params WHERE module = 'backup' AND param_name IN ('drive_refresh_token', 'drive_client_secret') AND param_value != ''",
      )
      .all();
    expect(secretParamRows).toHaveLength(0);
    restoredMetaDb.close();

    // Verify that if a leaked secret remains in staged config, scanStagingSnapshotForSecrets reports it
    fs.writeFileSync(
      path.join(restoreDir, 'config', 'leaked.env'),
      'NOTION_TOKEN=ntn_1234567890abcdef1234567890abcdef\n',
      'utf8',
    );
    const findings = scanStagingSnapshotForSecrets(restoreDir);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('2. enforces password validation, old_password check on change, key versioning, and audit log', async () => {
    const engine = createEngine();

    // Mismatched confirmation rejected
    await expect(
      engine.setOrChangePassword({
        userId: 'admin',
        newPassword: 'password-one-12345',
        confirmPassword: 'password-two-12345',
      }),
    ).rejects.toThrow(/PASSWORD_MISMATCH/);

    // Short password (<12 chars) rejected
    await expect(
      engine.setOrChangePassword({
        userId: 'admin',
        newPassword: 'short',
        confirmPassword: 'short',
      }),
    ).rejects.toThrow(/PASSWORD_TOO_SHORT/);

    // Initial password setup succeeds (key_version = 1)
    const v1 = await engine.setOrChangePassword({
      userId: 'admin-user',
      newPassword: 'first-strong-password-123',
      confirmPassword: 'first-strong-password-123',
    });
    expect(v1.key_version).toBe(1);

    const run1 = await engine.runBackup('manual');
    expect(run1.status).toBe('success');
    const v1FilePath = path.join(localBackupDir, run1.file_name!);

    // Changing password without oldPassword or with wrong oldPassword fails
    await expect(
      engine.setOrChangePassword({
        userId: 'admin-user',
        newPassword: 'second-strong-password-456',
        confirmPassword: 'second-strong-password-456',
      }),
    ).rejects.toThrow(/OLD_PASSWORD_REQUIRED/);

    await expect(
      engine.setOrChangePassword({
        userId: 'admin-user',
        oldPassword: 'wrong-old-password-000',
        newPassword: 'second-strong-password-456',
        confirmPassword: 'second-strong-password-456',
      }),
    ).rejects.toThrow(/INVALID_OLD_PASSWORD/);

    // Changing password with correct oldPassword increments key_version to 2
    const v2 = await engine.setOrChangePassword({
      userId: 'admin-user',
      oldPassword: 'first-strong-password-123',
      newPassword: 'second-strong-password-456',
      confirmPassword: 'second-strong-password-456',
    });
    expect(v2.key_version).toBe(2);

    // v1 backup still decrypts with v1 password and fails with v2 password
    const v1Bytes = fs.readFileSync(v1FilePath);
    const decryptedV1 = decryptBackupPayload(v1Bytes, 'first-strong-password-123');
    expect(decryptedV1.header.keyVersion).toBe(1);
    expect(decryptedV1.plaintext.byteLength).toBeGreaterThan(0);

    expect(() => decryptBackupPayload(v1Bytes, 'second-strong-password-456')).toThrow();

    // Audit log contains set + change records and never contains plaintext passwords
    const status = await engine.getStatus();
    expect(status.audit_log).toHaveLength(2);
    expect(status.audit_log[0]?.event).toBe('set');
    expect(status.audit_log[0]?.new_version).toBe(1);
    expect(status.audit_log[1]?.event).toBe('change');
    expect(status.audit_log[1]?.old_version).toBe(1);
    expect(status.audit_log[1]?.new_version).toBe(2);
    const serializedAudit = JSON.stringify(status.audit_log);
    expect(serializedAudit).not.toContain('first-strong-password-123');
    expect(serializedAudit).not.toContain('second-strong-password-456');
  });

  it('3. snapshots live WAL SQLite databases and restores ~200-char Windows long paths intact', async () => {
    const longLogsDir = path.join(coreDataDir, 'instances', 'default', 'memory-generation-logs');
    fs.mkdirSync(longLogsDir, { recursive: true });

    // Create a ~200-character filename inside memory-generation-logs
    const longFileName = `gen-log-${'x'.repeat(185)}.json`;
    expect(longFileName.length).toBeGreaterThan(195);
    const longFileContent = JSON.stringify({ ok: true, id: longFileName });
    fs.writeFileSync(path.join(longLogsDir, longFileName), longFileContent, 'utf8');

    // Keep an active WAL connection open on vectors.db during backup
    const vecDbPath = path.join(coreDataDir, 'vectors.db');
    const activeVecDb = new DatabaseSync(vecDbPath);
    activeVecDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE memory_items (id INTEGER PRIMARY KEY, text TEXT);
      INSERT INTO memory_items (text) VALUES ('wal-entry-1'), ('wal-entry-2');
    `);

    try {
      const engine = createEngine({
        getVectorDb: () => activeVecDb,
      });
      await engine.setOrChangePassword({
        userId: 'admin',
        newPassword: 'wal-and-long-path-password',
        confirmPassword: 'wal-and-long-path-password',
      });

      const run = await engine.runBackup('manual');
      expect(run.status).toBe('success');

      const restoreTarget = path.join(rootDir, 'restored-full');
      const res = await restoreBackupArchive({
        archivePath: path.join(localBackupDir, run.file_name!),
        password: 'wal-and-long-path-password',
        targetDir: restoreTarget,
      });
      expect(res.verifiedDbs.length).toBeGreaterThanOrEqual(3);

      // Check restored WAL database content
      const restoredVecDb = new DatabaseSync(
        path.join(restoreTarget, 'core-data', 'vectors.db'),
        { readOnly: true },
      );
      const rows = restoredVecDb.prepare('SELECT text FROM memory_items ORDER BY id').all() as Array<{
        text: string;
      }>;
      expect(rows.map((r) => r.text)).toEqual(['wal-entry-1', 'wal-entry-2']);
      restoredVecDb.close();

      // Check restored ~200-char filename
      const restoredLongFile = path.join(
        restoreTarget,
        'core-data',
        'instances',
        'default',
        'memory-generation-logs',
        longFileName,
      );
      expect(fs.existsSync(restoredLongFile)).toBe(true);
      expect(fs.readFileSync(restoredLongFile, 'utf8')).toBe(longFileContent);
    } finally {
      activeVecDb.close();
    }
  });

  it('4. executes startup catch-up once per Taipei day and prunes only expired backup files (>30 days)', async () => {
    const engine = createEngine();
    await engine.setOrChangePassword({
      userId: 'admin',
      newPassword: 'schedule-catchup-password',
      confirmPassword: 'schedule-catchup-password',
    });
    await engine.updateSettings({
      enabled: true,
      schedule_hour: 4,
      delete_older_than_month: true,
    });

    // Simulate 2026-05-10 09:30 Asia/Taipei (01:30 UTC), which is > 04:00 Taipei
    const simulatedNowMs = Date.UTC(2026, 4, 10, 1, 30, 0);

    const firstCatchup = await engine.checkAndRunScheduled(simulatedNowMs);
    expect(firstCatchup).not.toBeNull();
    expect(firstCatchup?.trigger).toBe('catchup');
    expect(firstCatchup?.status).toBe('success');

    // Second check on the same Taipei day should not run again
    const secondCatchup = await engine.checkAndRunScheduled(simulatedNowMs + 3600_000);
    expect(secondCatchup).toBeNull();

    // Test 30-day retention pruning on Google Drive mock + local backups
    const nowMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const deletedUrls: string[] = [];
    const fakeDriveFiles = [
      {
        id: 'old-backup-1',
        name: 'pmh-backup-20260101-0400-v1.tar.gz.age',
      },
      {
        id: 'recent-backup-1',
        name: 'pmh-backup-20260501-0400-v1.tar.gz.age',
      },
      {
        id: 'unrelated-file-1',
        name: 'important-manual-notes.pdf',
      },
    ];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        deletedUrls.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ files: fakeDriveFiles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const pruned = await pruneOldDriveBackups('fake-token', 'folder-1', 30, nowMs, mockFetch);
    expect(pruned).toEqual(['pmh-backup-20260101-0400-v1.tar.gz.age']);
    expect(deletedUrls).toHaveLength(1);
    expect(deletedUrls[0]).toContain('old-backup-1');

    // Also verify local pruning leaves unrelated files and recent backups alone
    fs.writeFileSync(path.join(localBackupDir, 'pmh-backup-20260101-0400-v1.tar.gz.age'), 'old');
    fs.writeFileSync(path.join(localBackupDir, 'pmh-backup-20260501-0400-v1.tar.gz.age'), 'recent');
    fs.writeFileSync(path.join(localBackupDir, 'keep-me.txt'), 'unrelated');

    const localPruned = engine.pruneLocalBackups(30, nowMs);
    expect(localPruned).toEqual(['pmh-backup-20260101-0400-v1.tar.gz.age']);
    expect(fs.existsSync(path.join(localBackupDir, 'pmh-backup-20260501-0400-v1.tar.gz.age'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(localBackupDir, 'keep-me.txt'))).toBe(true);
  });
});
