/**
 * scheduler.ts — Railway channel discovery scheduler.
 * Replaces the Cloudflare Durable Object Alarm.
 *
 * Behavior:
 *  - Runs runChannelDiscovery() every N seconds (from DB config).
 *  - Concurrency guard: if a discovery is already running, skip the cycle.
 *  - Reads the current discovery_interval_sec from DB on every tick so
 *    admin panel changes take effect without restart.
 *  - Exports start/stop functions for graceful shutdown.
 */

import type { Env } from "./types.js";
import { getMonitoringConfig } from "./db.js";
import { runChannelDiscovery } from "./monitor.js";

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS     = 1_000;
const MAX_INTERVAL_MS     = 300_000;

let timer:   ReturnType<typeof setTimeout> | null = null;
let running  = false; // concurrency guard

async function tick(env: Env): Promise<void> {
  if (running) {
    scheduleNext(env);
    return;
  }
  running = true;
  try {
    await runChannelDiscovery(env);
  } catch (err) {
    console.error("[scheduler] Discovery error:", String(err));
  } finally {
    running = false;
    scheduleNext(env);
  }
}

async function getIntervalMs(env: Env): Promise<number> {
  try {
    const cfg = await getMonitoringConfig(env);
    const sec = cfg.discovery_interval_sec ?? 5;
    return Math.min(Math.max(sec * 1000, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
  } catch {
    return DEFAULT_INTERVAL_MS;
  }
}

function scheduleNext(env: Env): void {
  if (timer !== null) return; // already scheduled
  // Schedule next tick after reading current interval from DB
  getIntervalMs(env).then((ms) => {
    timer = setTimeout(() => {
      timer = null;
      tick(env);
    }, ms);
  }).catch(() => {
    // Fallback on DB error
    timer = setTimeout(() => {
      timer = null;
      tick(env);
    }, DEFAULT_INTERVAL_MS);
  });
}

/** Start the discovery scheduler. Call once on application startup. */
export function startDiscoveryScheduler(env: Env): void {
  if (timer !== null) return; // already running
  console.log("[scheduler] Discovery scheduler started.");
  tick(env);
}

/** Stop the discovery scheduler. Call on graceful shutdown. */
export function stopDiscoveryScheduler(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("[scheduler] Discovery scheduler stopped.");
}
