/**
 * LlmBackendCard — LLM 抽取後端狀態 + 切換 + 用量卡片（GuidePage 內嵌）。
 *
 * 直接打 claude-llm-proxy（預設 :8622，跟這個 Panel 是同一台主機、不同 port）的
 * /control/backend、/stats 兩個端點——不經 Panel 自己的後端，因為這兩個端點只是
 * 本機 localhost 控制面，且 proxy 已開 CORS。proxy 沒啟動時（例如你只用 Qwen、
 * 沒裝這個選配元件）整張卡片會顯示「無法連線」，不影響頁面其他部分。
 */
import { useCallback, useEffect, useState } from 'react';

type BackendMode = 'proxy' | 'qwen' | 'unknown';

interface BackendStatus {
  mode: BackendMode;
  detail: string;
}

interface ModelUsage {
  calls: number;
  costUsd: number;
}

interface UsageBucket {
  calls: number;
  errors: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  byModel: Record<string, ModelUsage>;
}

interface Stats {
  today: UsageBucket;
  last7Days: UsageBucket;
  allTime: UsageBucket;
  note: string;
}

const PROXY_ORIGIN = `${window.location.protocol}//${window.location.hostname}:8622`;

function fmtUsd(n: number) {
  return `$${n.toFixed(4)}`;
}

export function LlmBackendCard() {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [switching, setSwitching] = useState<BackendMode | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    Promise.all([
      fetch(`${PROXY_ORIGIN}/control/backend`).then((r) => r.json()),
      fetch(`${PROXY_ORIGIN}/stats`).then((r) => r.json()),
    ])
      .then(([s, st]) => {
        setStatus(s);
        setStats(st);
        setUnreachable(false);
      })
      .catch(() => setUnreachable(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSwitch = async (mode: 'proxy' | 'qwen') => {
    setSwitching(mode);
    setError('');
    try {
      const res = await fetch(`${PROXY_ORIGIN}/control/backend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(null);
    }
  };

  if (unreachable) {
    return (
      <section className="guide-llm-backend">
        <h3>LLM 抽取後端</h3>
        <p className="guide-llm-backend-unreachable">
          無法連線到 claude-llm-proxy（{PROXY_ORIGIN}）——如果你沒有部署這個選配元件，可以忽略；
          如果有，確認它是否正在執行。
        </p>
      </section>
    );
  }

  const bucket = stats?.today;

  return (
    <section className="guide-llm-backend">
      <div className="guide-llm-backend-head">
        <h3>LLM 抽取後端</h3>
        <span className={`guide-llm-backend-badge ${status?.mode ?? 'unknown'}`}>
          {status?.mode === 'proxy' ? 'Claude 訂閱 (Proxy)' : status?.mode === 'qwen' ? '本地 Qwen' : '未知'}
        </span>
      </div>
      <p className="guide-llm-backend-detail">{status?.detail}</p>

      <div className="guide-llm-backend-switch">
        <button
          type="button"
          className={status?.mode === 'qwen' ? 'active' : ''}
          disabled={switching !== null || status?.mode === 'qwen'}
          onClick={() => handleSwitch('qwen')}
        >
          {switching === 'qwen' ? '切換中…' : '切到本地 Qwen'}
        </button>
        <button
          type="button"
          className={status?.mode === 'proxy' ? 'active' : ''}
          disabled={switching !== null || status?.mode === 'proxy'}
          onClick={() => handleSwitch('proxy')}
        >
          {switching === 'proxy' ? '切換中…' : '切到 Claude 訂閱'}
        </button>
      </div>
      {status?.mode !== 'qwen' && (
        <p className="guide-llm-backend-warning">
          ⓘ Claude 訂閱模式下，L2 場景抽取、L3 人格生成靠 proxy 自己模擬 tool-calling（請模型輸出
          JSON 表示要呼叫的工具，proxy 再轉成標準格式）運作——機制已驗證可行，但還沒在正式 pipeline
          的即時觸發上實際跑過，遇到問題請切回 Qwen。Knowledge wiki 摘要不受影響（它有自己獨立的
          LLM 綁定，不跟著這裡切換）。
        </p>
      )}
      {error && <p className="guide-llm-backend-error">{error}</p>}

      {bucket && (
        <div className="guide-llm-backend-stats">
          <div className="guide-llm-backend-stat">
            <b>{bucket.calls}</b>
            <small>今日呼叫次數</small>
          </div>
          <div className="guide-llm-backend-stat">
            <b>{fmtUsd(bucket.costUsd)}</b>
            <small>今日等值花費</small>
          </div>
          <div className="guide-llm-backend-stat">
            <b>{fmtUsd(stats!.last7Days.costUsd)}</b>
            <small>近 7 日等值花費</small>
          </div>
          <div className="guide-llm-backend-stat">
            <b>{fmtUsd(stats!.allTime.costUsd)}</b>
            <small>累計等值花費</small>
          </div>
        </div>
      )}
      {stats && (
        <p className="guide-llm-backend-note">
          等值花費是 Anthropic 依訂閱額度消耗量換算的定價，用來跟你平常互動用 Claude Code 的花費比較「記憶抽取佔了多少比例」——不是另外收費，一樣吃你的訂閱 5 小時滾動配額。
        </p>
      )}
    </section>
  );
}
