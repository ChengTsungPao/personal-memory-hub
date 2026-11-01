/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, Navigate, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { GuidePage } from '@/pages/GuidePage';
import { ModelSettingsPage } from '@/pages/ModelSettingsPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { BackupSettingsPage } from '@/pages/BackupSettingsPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'models', element: <ModelSettingsPage /> },
      { path: 'backup', element: <BackupSettingsPage /> },
      { path: 'docs', element: <GuidePage /> },
      { path: 'docs/:tab', element: <GuidePage /> },
      { path: 'guide', element: <Navigate to="/docs/quick" replace /> },
    ],
  },
];

// 在 createHashRouter 初始化前拦截 Google Drive 备份 OAuth 回调 (?state=pmh_backup_...&code=...)：
// 先存入 sessionStorage 并把 hash 切换为 #/backup，避免 main.tsx 的 stripWoaAuthParams 清掉参数或跳回首页。
(function interceptBackupOAuthCallback() {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const state = url.searchParams.get('state') ?? '';
    if (state.startsWith('pmh_backup_')) {
      const code = url.searchParams.get('code') ?? '';
      const error = url.searchParams.get('error') ?? '';
      sessionStorage.setItem(
        'pmh_google_oauth_callback',
        JSON.stringify({ code, state, error }),
      );
      for (const key of ['code', 'state', 'scope', 'error', 'authuser', 'prompt']) {
        url.searchParams.delete(key);
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}#/backup`);
    }
  } catch {
    /* ignore */
  }
})();

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);
