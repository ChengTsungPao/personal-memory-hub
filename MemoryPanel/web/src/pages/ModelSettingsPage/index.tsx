import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LlmBackendCard } from '@/pages/GuidePage/LlmBackendCard';
import '@/pages/GuidePage/style.css';

export function ModelSettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="guide-page">
      <header className="guide-titlebar">
        <div>
          <button type="button" className="guide-back" onClick={() => navigate(-1)}>
            ← {t('guide.back')}
          </button>
          <h1>{t('models.title', '模型調整 (LLM Backend)')}</h1>
          <p>{t('models.subtitle', '管理核心 LLM 抽取後端，支援 LLM Gateway、OpenRouter 與 Claude LLM Proxy 切換')}</p>
        </div>
        <span className="guide-brand">{t('guide.brand')}</span>
      </header>

      <div style={{ marginTop: 20 }}>
        <LlmBackendCard />
      </div>
    </div>
  );
}
