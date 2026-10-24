/**
 * ConnectorScheduler — wakes up periodically and runs every connector that is due.
 *
 * "Due" is decided from persisted state (last success time), not process uptime, so a
 * restart neither skips a sync nor triggers a redundant one. Checking hourly is cheap: for
 * a disabled or not-yet-due connector the tick does nothing and makes no network request.
 *
 * Inert unless the operator gate is on AND an interval is set (0 = manual trigger only).
 */

import { createLogger } from "../logger.js";
import type { ConnectorsConfig } from "./config.js";
import type { ConnectorSyncService } from "./sync-service.js";

const log = createLogger("connector-scheduler");

const TICK_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

export interface ConnectorSchedulerDeps {
  service: ConnectorSyncService;
  config: ConnectorsConfig;
  tickMs?: number;
  startupDelayMs?: number;
}

export class ConnectorScheduler {
  private readonly service: ConnectorSyncService;
  private readonly config: ConnectorsConfig;
  private readonly tickMs: number;
  private readonly startupDelayMs: number;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: ConnectorSchedulerDeps) {
    this.service = deps.service;
    this.config = deps.config;
    this.tickMs = deps.tickMs ?? TICK_MS;
    this.startupDelayMs = deps.startupDelayMs ?? STARTUP_DELAY_MS;
  }

  /** Returns true when timers were armed. */
  start(): boolean {
    if (!this.config.enabled) return false;
    this.service.recoverInterrupted();
    if (this.config.intervalHours <= 0) {
      log.info("connectors enabled, scheduled sync off (interval=0): manual trigger only");
      return false;
    }
    if (this.tickTimer) return true;
    this.startupTimer = setTimeout(() => void this.tick(), this.startupDelayMs);
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    // Never keep the process alive just for this.
    this.startupTimer.unref?.();
    this.tickTimer.unref?.();
    log.info(`connector scheduler started (every ${this.config.intervalHours}h, checked hourly)`);
    return true;
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.startupTimer = null;
    this.tickTimer = null;
  }

  /** Run every due connector, one at a time. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const id of this.service.listConnectorIds()) {
        if (this.service.isDue(id)) await this.service.runOnce(id);
      }
    } catch (err) {
      log.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
