/**
 * v3 backup router (`/v3/backup/*`) — Admin-only backup management endpoints.
 *
 * Auth layers:
 *   - Layer 1 (Bearer): handled by server.ts `checkAuthForV2` before reaching here
 *   - Layer 2 (`x-tdai-service-id`): `extractInstanceId`
 *   - Layer 3 (`x-tdai-user-key`): `authenticateV3` + `isSystemAdmin` check
 */

import type * as http from "node:http";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
} from "../gateway/v2-router.js";
import { extractInstanceId } from "../metadata/router/instance.js";
import {
  extractUserKeyHeader,
  authenticateV3,
} from "../metadata/router/auth.js";
import { MetadataError, type MetadataService } from "../metadata/service/metadata-service.js";
import type { BackupEngine } from "./engine.js";

export const V3_BACKUP_PREFIX = "/v3/backup";

export interface BackupRouterDeps {
  getBackupEngine: () => BackupEngine;
  getMetadataService: (instanceId: string) => Promise<MetadataService | undefined>;
}

export async function handleV3BackupRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: BackupRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(`${V3_BACKUP_PREFIX}/`)) return false;

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  if (method.toUpperCase() !== "POST") {
    sendJson(res, 405, errorEnvelope(405, `Method ${method} not allowed`, requestId));
    return true;
  }

  let instanceId: string;
  try {
    instanceId = extractInstanceId(req.headers);
  } catch (err) {
    if (err instanceof MetadataError) {
      sendJson(res, 400, errorEnvelope(400, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    throw err;
  }

  const svc = await deps.getMetadataService(instanceId);
  if (!svc) {
    sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
    return true;
  }

  const userKey = extractUserKeyHeader(req.headers);
  if (!userKey) {
    sendJson(res, 401, errorEnvelope(401, "unauthorized: missing x-tdai-user-key", requestId));
    return true;
  }

  const authResult = await authenticateV3(userKey, svc);
  if (!authResult.ok || !authResult.ctx) {
    sendJson(
      res,
      authResult.status ?? 401,
      errorEnvelope(authResult.status ?? 401, `unauthorized: ${authResult.reason}`, requestId),
    );
    return true;
  }

  if (!authResult.ctx.isSystemAdmin) {
    sendJson(res, 403, errorEnvelope(403, "forbidden: backup requires system_admin", requestId));
    return true;
  }

  const body = (await parseJsonBody<Record<string, unknown>>(req).catch(() => ({}))) ?? {};
  const engine = deps.getBackupEngine();
  const action = pathname.slice(V3_BACKUP_PREFIX.length);

  try {
    switch (action) {
      case "/status": {
        const status = await engine.getStatus(instanceId);
        sendJson(res, 200, successEnvelope(status, requestId));
        return true;
      }
      case "/password": {
        const result = await engine.setOrChangePassword({
          userId: authResult.ctx.userId ?? "system_admin",
          oldPassword: typeof body.old_password === "string" ? body.old_password : undefined,
          newPassword: typeof body.new_password === "string" ? body.new_password : "",
          confirmPassword: typeof body.confirm_password === "string" ? body.confirm_password : "",
          instanceId,
        });
        sendJson(res, 200, successEnvelope(result, requestId));
        return true;
      }
      case "/settings": {
        const updated = await engine.updateSettings(
          {
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            drive_path: typeof body.drive_path === "string" ? body.drive_path : undefined,
            delete_older_than_month:
              typeof body.delete_older_than_month === "boolean"
                ? body.delete_older_than_month
                : undefined,
            schedule_hour: typeof body.schedule_hour === "number" ? body.schedule_hour : undefined,
            drive_client_id: typeof body.drive_client_id === "string" ? body.drive_client_id : undefined,
            drive_client_secret:
              typeof body.drive_client_secret === "string" ? body.drive_client_secret : undefined,
          },
          instanceId,
        );
        sendJson(res, 200, successEnvelope(updated, requestId));
        return true;
      }
      case "/google-auth/start": {
        if (typeof body.redirect_uri === "string" && body.redirect_uri.trim()) {
          const redirectSession = await engine.startGoogleOAuthRedirectFlow(
            {
              redirect_uri: body.redirect_uri,
              client_id: typeof body.client_id === "string" ? body.client_id : undefined,
              client_secret: typeof body.client_secret === "string" ? body.client_secret : undefined,
            },
            instanceId,
          );
          sendJson(res, 200, successEnvelope(redirectSession, requestId));
          return true;
        }
        const session = await engine.startGoogleDeviceFlow(
          {
            client_id: typeof body.client_id === "string" ? body.client_id : undefined,
            client_secret: typeof body.client_secret === "string" ? body.client_secret : undefined,
          },
          instanceId,
        );
        sendJson(res, 200, successEnvelope(session, requestId));
        return true;
      }
      case "/google-auth/callback": {
        const callbackRes = await engine.completeGoogleOAuthCallback(
          {
            code: typeof body.code === "string" ? body.code : "",
            state: typeof body.state === "string" ? body.state : undefined,
            redirect_uri: typeof body.redirect_uri === "string" ? body.redirect_uri : undefined,
          },
          instanceId,
        );
        sendJson(res, 200, successEnvelope(callbackRes, requestId));
        return true;
      }
      case "/google-auth/poll": {
        const pollRes = await engine.pollGoogleDeviceFlow(
          typeof body.device_code === "string" ? body.device_code : undefined,
          instanceId,
        );
        sendJson(res, 200, successEnvelope(pollRes, requestId));
        return true;
      }
      case "/run": {
        const runRes = await engine.runBackup("manual", instanceId);
        sendJson(res, 200, successEnvelope(runRes, requestId));
        return true;
      }
      default:
        sendJson(res, 404, errorEnvelope(404, `Unknown backup endpoint: ${pathname}`, requestId));
        return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isClientErr =
      /^(PASSWORD_|OLD_PASSWORD_|INVALID_OLD_PASSWORD|MISSING_OAUTH_|INVALID_OAUTH_|NO_ACTIVE_DEVICE_FLOW)/.test(
        msg,
      );
    sendJson(res, isClientErr ? 400 : 500, errorEnvelope(isClientErr ? 400 : 500, msg, requestId));
    return true;
  }
}
