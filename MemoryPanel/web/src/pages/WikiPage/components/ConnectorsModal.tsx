import { useEffect, useState, useCallback } from 'react';
import { Alert, Button, Form, Modal, Switch, Tag, Text } from 'tea-component';
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

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await knowledgeApi.connectors.status();
      setConnectors(res.connectors ?? []);
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
          <Alert type="info" style={{ marginBottom: 16 }}>
            系統尚未啟用外部知識源總開關。請於 Knowledge Service 環境變數設定{' '}
            <code>KNOWLEDGE_CONNECTORS_ENABLED=true</code> 與對應的 Token（例如{' '}
            <code>KNOWLEDGE_CONNECTOR_NOTION_TOKEN=ntn_...</code>）後重啟服務。
          </Alert>
        )}

        {loading && connectors.length === 0 ? (
          <Text theme="label">載入中...</Text>
        ) : (
          connectors.map((item) => {
            const stats = item.last_stats;
            const isBusy = busyId === item.id || item.running;
            return (
              <div
                key={item.id}
                style={{
                  border: '1px solid var(--tea-color-border, #e5e7eb)',
                  borderRadius: 8,
                  padding: 16,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text reset style={{ fontWeight: 600, fontSize: 15, textTransform: 'capitalize' }}>
                      {item.id}
                    </Text>
                    <Tag theme={item.available ? 'success' : 'default'}>
                      {item.available ? '總開關已開' : '總開關關閉'}
                    </Tag>
                    <Tag theme={item.configured ? 'primary' : 'warning'}>
                      {item.configured ? '憑證已配置' : '待配置 Token / Team'}
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
                      disabled={!item.available || !item.enabled || isBusy}
                      loading={item.running}
                      onClick={() => handleTrigger(item)}
                    >
                      立即同步
                    </Button>
                  </div>
                </div>

                <Form layout="inline">
                  <Form.Item label="目標 Wiki">
                    <Text>{item.wiki_name}</Text>
                  </Form.Item>
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
