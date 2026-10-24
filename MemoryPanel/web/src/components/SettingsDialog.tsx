/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * 当前只有一个 Tab：「权限管理」— 控制资源管理模块的开关
 * （Wiki / Code / Skill / Chat_Memory），防止未稳定使用的模块
 * 被注入内核运行。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Switch,
  Text,
  Tag,
  Modal,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  descKey: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'settings.module.wiki',
    descKey: 'settings.module.wiki.desc',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'settings.module.code',
    descKey: 'settings.module.code.desc',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'settings.module.skill',
    descKey: 'settings.module.skill.desc',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'settings.module.chatMemory',
    descKey: 'settings.module.chatMemory.desc',
    icon: <ChatIcon size={16} />,
  },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <Modal visible caption={t('settings.caption')} size="l" onClose={onClose}>
      <Modal.Body>
        {/* 系统与指引模块入口 */}
        <div style={{ marginBottom: 24 }}>
          <Text theme="label" style={{ display: 'block', marginBottom: 10, fontWeight: 600 }}>
            {t('settings.navSection.title')}
          </Text>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {/* 1. 模型调整 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '12px 14px',
                border: '1px solid var(--tea-color-border-primary-default)',
                borderRadius: 6,
                background: 'var(--tea-color-bg-secondary-default)',
              }}
            >
              <div>
                <Text style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {t('settings.nav.models.title')}
                </Text>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  {t('settings.nav.models.desc')}
                </Text>
              </div>
              <Button
                type="primary"
                style={{ marginTop: 12, alignSelf: 'flex-start' }}
                onClick={() => {
                  onClose();
                  navigate('/models');
                }}
              >
                {t('settings.nav.models.btn')}
              </Button>
            </div>

            {/* 2. 快速上手 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '12px 14px',
                border: '1px solid var(--tea-color-border-primary-default)',
                borderRadius: 6,
                background: 'var(--tea-color-bg-secondary-default)',
              }}
            >
              <div>
                <Text style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {t('settings.nav.quick.title')}
                </Text>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  {t('settings.nav.quick.desc')}
                </Text>
              </div>
              <Button
                type="weak"
                style={{ marginTop: 12, alignSelf: 'flex-start' }}
                onClick={() => {
                  onClose();
                  navigate('/docs/quick');
                }}
              >
                {t('settings.nav.quick.btn')}
              </Button>
            </div>

            {/* 3. 最佳实践 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '12px 14px',
                border: '1px solid var(--tea-color-border-primary-default)',
                borderRadius: 6,
                background: 'var(--tea-color-bg-secondary-default)',
              }}
            >
              <div>
                <Text style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {t('settings.nav.practice.title')}
                </Text>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  {t('settings.nav.practice.desc')}
                </Text>
              </div>
              <Button
                type="weak"
                style={{ marginTop: 12, alignSelf: 'flex-start' }}
                onClick={() => {
                  onClose();
                  navigate('/docs/practice');
                }}
              >
                {t('settings.nav.practice.btn')}
              </Button>
            </div>

            {/* 4. 命令速查 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '12px 14px',
                border: '1px solid var(--tea-color-border-primary-default)',
                borderRadius: 6,
                background: 'var(--tea-color-bg-secondary-default)',
              }}
            >
              <div>
                <Text style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {t('settings.nav.commands.title')}
                </Text>
                <Text theme="weak" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  {t('settings.nav.commands.desc')}
                </Text>
              </div>
              <Button
                type="weak"
                style={{ marginTop: 12, alignSelf: 'flex-start' }}
                onClick={() => {
                  onClose();
                  navigate('/docs/commands');
                }}
              >
                {t('settings.nav.commands.btn')}
              </Button>
            </div>
          </div>
        </div>

        <div>
          <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
            {t('settings.title')}
          </Text>
          <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
            {t('settings.desc')}
          </Text>
          {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
          {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {RESOURCE_MODULES.map((mod) => (
              <div
                key={mod.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  border: '1px solid var(--tea-color-border-primary-default)',
                  borderRadius: 6,
                  background: enabled[mod.id]
                    ? 'var(--tea-color-bg-brand-lighten-default)'
                    : 'var(--tea-color-bg-primary-default)',
                  transition: 'background-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                    {mod.icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 13, fontWeight: 500 }}>
                        {t(mod.labelKey)}
                      </Text>
                      {savingKey === mod.paramKey ? (
                        <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                      ) : enabled[mod.id] ? (
                        <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                      ) : (
                        <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                      )}
                    </div>
                    <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                      {t(mod.descKey)}
                    </Text>
                  </div>
                </div>
                <Switch
                  value={enabled[mod.id]}
                  disabled={loading || savingKey === mod.paramKey}
                  onChange={(v) => void handleToggle(mod, v)}
                />
              </div>
            ))}
          </div>
        </div>
      </Modal.Body>
    </Modal>
  );
}
