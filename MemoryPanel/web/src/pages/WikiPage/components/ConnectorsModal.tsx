import { useEffect, useState, useCallback } from 'react';
import { Alert, Button, Form, Input, Modal, Switch, Tag, Text } from 'tea-component';
import { knowledgeApi, type ConnectorStatusItem } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { formatShortTime } from '../constants/wiki-constants';

export interface ConnectorsModalProps {
  visible: boolean;
  activeTeamId: string | null;
  onClose: () => void;
  onSynced?: () => void;
}

export function ConnectorsModal({ visible, activeTeamId, onClose, onSynced }: ConnectorsModalProps) {
  const [connectors, setConnectors] = useState<ConnectorStatusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});
  const [wikiNameDrafts, setWikiNameDrafts] = useState<Record<string, string>>({});

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await knowledgeApi.connectors.status();
      const items = res.connectors ?? [];
      setConnectors(items);
      setWikiNameDrafts((prev) => {
        const next = { ...prev };
        for (const it of items) {
          if (next[it.id] === undefined) next[it.id] = it.wiki_name;
        }
        return next;
      });
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : '載入外部知識源狀態失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void loadStatus();
  }, [visible, loadStatus]);

  // Poll while any connector is running
  useEffect(() => {
    if (!visible || !connectors.some((c) => c.running)) return;
    const timer = setInterval(async () => {
      try {
        const res = await knowledgeApi.connectors.status();
        const next = res.connectors ?? [];
        setConnectors(next);
        if (!next.some((c) => c.running)) {
          onSynced?.();
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [visible, connectors, onSynced]);

  const handleSaveConfig = async (item: ConnectorStatusItem) => {
    setBusyId(item.id);
    try {
      const rawToken = (tokenDrafts[item.id] ?? '').trim();
      const rawWikiName = (wikiNameDrafts[item.id] ?? item.wiki_name).trim();
      await knowledgeApi.connectors.configure(item.id, {
        ...(rawToken ? { token: rawToken } : {}),
        ...(rawWikiName ? { wiki_name: rawWikiName } : {}),
        team_id: activeTeamId ?? undefined,
      });
      setTokenDrafts((prev) => ({ ...prev, [item.id]: '' }));
      tea.notify.success(`已儲存 ${item.id.toUpperCase()} 設定`);
      await loadStatus();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : '儲存設定失敗');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (item: ConnectorStatusItem, nextEnabled: boolean) => {
    setBusyId(item.id);
    try {
      await knowledgeApi.connectors.setEnabled(item.id, nextEnabled, activeTeamId ?? undefined);
      tea.notify.success(`${item.id.toUpperCase()} 同步已${nextEnabled ? '啟用' : '停用'}`);
      await loadStatus();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : '切換狀態失敗');
    } finally {
      setBusyId(null);
    }
  };

  const handleTrigger = async (item: ConnectorStatusItem) => {
    setBusyId(item.id);
    try {
      await knowledgeApi.connectors.trigger(item.id, activeTeamId ?? undefined);
      tea.notify.success(`已觸發 ${item.id.toUpperCase()} 增量同步`);
      await loadStatus();
      onSynced?.();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : '觸發同步失敗');
    } finally {
      setBusyId(null);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible caption="外部知識源同步 (Connectors)" size="m" onClose={onClose}>
      <Modal.Body>
        {connectors.length > 0 && !connectors[0]?.available && (
          <Alert type="warning" style={{ marginBottom: 16 }}>
            系統管理員已透過 <code>KNOWLEDGE_CONNECTORS_ENABLED=false</code> 關閉外部知識源同步功能。
          </Alert>
        )}

        {loading && connectors.length === 0 ? (
          <Text theme="label">載入中...</Text>
        ) : (
          connectors.map((item) => {
            const stats = item.last_stats;
            const isBusy = busyId === item.id || item.running;
            const draftToken = tokenDrafts[item.id] ?? '';
            const draftWikiName = wikiNameDrafts[item.id] ?? item.wiki_name;
            return (
              <div key={item.id} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 6, paddingLeft: 2, textAlign: 'left' }}>
                  <Text reset style={{ fontWeight: 600, fontSize: 15, textTransform: 'capitalize' }}>
                    {item.id}
                  </Text>
                </div>
                <div
                  style={{
                    border: '1px solid var(--tea-color-border-primary-default)',
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <Tag theme={item.has_token ? 'success' : 'warning'}>
                        {item.has_token ? 'Token 已設定' : '尚未設定 Token'}
                      </Tag>
                      <Tag theme={item.enabled ? 'primary' : 'default'}>
                        {item.enabled ? '同步已開啟' : '已停用'}
                      </Tag>
                      {item.running && <Tag theme="warning">同步中...</Tag>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Switch
                        value={item.enabled}
                        disabled={!item.available || isBusy}
                        onChange={(val) => handleToggle(item, val)}
                      >
                        啟用同步
                      </Switch>
                      <Button
                        type="primary"
                        disabled={!item.available || !item.enabled || !item.has_token || isBusy}
                        loading={item.running}
                        onClick={() => handleTrigger(item)}
                      >
                        立即同步
                      </Button>
                    </div>
                  </div>

                  <Form>
                    <Form.Item
                      label="Integration Token"
                      message="於 Notion 建立 Internal Integration 取得 ntn_... Token，並在欲同步的頂層頁面點選「⋯ → Connect to」授權該 Integration。"
                    >
                      <Input
                        type="password"
                        size="full"
                        disabled={!item.available || isBusy}
                        value={draftToken}
                        placeholder={
                          item.has_token
                            ? '已設定 Token（留空則保留原值，輸入新值可覆蓋）'
                            : '貼上 Notion Integration Secret (ntn_...)'
                        }
                        onChange={(val) => setTokenDrafts((prev) => ({ ...prev, [item.id]: val }))}
                      />
                    </Form.Item>
                    <Form.Item label="目標 Wiki 名稱">
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Input
                          size="m"
                          disabled={!item.available || isBusy}
                          value={draftWikiName}
                          placeholder="Notion"
                          onChange={(val) => setWikiNameDrafts((prev) => ({ ...prev, [item.id]: val }))}
                        />
                        <Button
                          type="weak"
                          disabled={!item.available || isBusy}
                          onClick={() => handleSaveConfig(item)}
                        >
                          儲存設定
                        </Button>
                      </div>
                    </Form.Item>
                  </Form>

                  <Form layout="inline" style={{ marginTop: 8 }}>
                    <Form.Item label="排程週期">
                      <Text>{item.interval_hours > 0 ? `每 ${item.interval_hours} 小時` : '僅手動觸發'}</Text>
                    </Form.Item>
                    <Form.Item label="已追蹤頁面">
                      <Text>{item.tracked_docs} 頁</Text>
                    </Form.Item>
                    <Form.Item label="上次同步">
                      <Text>{formatShortTime(item.last_success_at || item.last_run_at)}</Text>
                    </Form.Item>
                  </Form>

                  {stats && (
                    <div style={{ marginTop: 8 }}>
                      <Text theme="label">
                        上次結果：新增 +{stats.added} / 更新 ~{stats.updated} / 刪除 -{stats.deleted}
                        {stats.failed > 0 ? ` / 失敗 ${stats.failed}` : ''}
                        {stats.ingestTriggered ? '（已觸發 Wiki Ingest）' : '（無變更，未消耗 LLM Token）'}
                      </Text>
                    </div>
                  )}

                  {item.last_error && (
                    <Alert type="error" style={{ marginTop: 8 }}>
                      {item.last_error}
                    </Alert>
                  )}
                </div>
              </div>
            );
          })
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={() => void loadStatus()} disabled={loading}>
          重新整理狀態
        </Button>
        <Button type="primary" onClick={onClose}>
          關閉
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
