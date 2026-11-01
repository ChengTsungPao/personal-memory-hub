/**
 * `/api/v1/backup/*` — Transparent proxy to MemoryCore `/v3/backup/*` (admin-only).
 */

import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';

const ALLOWED_BACKUP_ACTIONS = new Set([
  'status',
  'password',
  'settings',
  'google-auth/start',
  'google-auth/poll',
  'run',
]);

function readBackupAction(path: string): string {
  const marker = '/backup/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

export function registerBackupRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/backup/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readBackupAction(c.req.path);
    if (!action || !ALLOWED_BACKUP_ACTIONS.has(action)) {
      return respondControlError(c, 404, 'UNKNOWN_BACKUP_ACTION');
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };
    const cred = toKernelCredentials(ctx, { timeoutMs: action === 'run' ? 180_000 : 30_000 });

    try {
      const envelope = await deps.kernelHttp.postEnvelope<unknown>(
        `/v3/backup/${action}`,
        body,
        cred,
      );
      return respondEnvelope(c, envelope);
    } catch (err) {
      return respondControlError(
        c,
        500,
        `BACKUP_PROXY_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
