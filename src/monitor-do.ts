/**
 * monitor-do.ts — Railway stub.
 * Replaces Cloudflare Durable Object with in-process equivalents.
 *
 * The DO Alarm is replaced by scheduler.ts (setInterval-based).
 * WebSocket broadcast uses the wsClients registry below.
 * The DO lock is replaced by a simple in-process mutex (sufficient for
 * single-process Railway deployment; upgrade to Redis if multi-instance needed).
 */

import type { Env, RealtimeEvent, MonitoringState } from "./types.js";
import type { WebSocket as WsType } from "ws";

/** Discovery interval constant — overridden at runtime by DB config */
export const DISCOVERY_INTERVAL_MS = 5_000;
/** Sign delay constant — fallback when DB is unavailable */
export const SIGN_DELAY_MS = 3_000;

// ─── WebSocket client registry ────────────────────────────────────────────────

const wsClients = new Set<WsType>();

export function registerWsClient(ws: WsType): void {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
  // Send initial PING
  try {
    ws.send(JSON.stringify({ type:"PING", payload:{ connected:true }, timestamp:Date.now() }));
  } catch {}
}

export async function broadcastEvent(_env: Env, event: RealtimeEvent): Promise<void> {
  const payload = JSON.stringify(event);
  const dead: WsType[] = [];
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { dead.push(ws); }
  }
  for (const ws of dead) wsClients.delete(ws);
}

// ─── In-process state (replaces DO storage) ───────────────────────────────────

let _monitoringState: MonitoringState = "INACTIVE";

export async function getDoState(_env: Env): Promise<{ lock: null; monitoringState: MonitoringState }> {
  return { lock: null, monitoringState: _monitoringState };
}
export async function setDoState(_env: Env, state: MonitoringState): Promise<void> {
  _monitoringState = state;
}

// ─── Lock stubs (unused in v2 multi-channel architecture) ─────────────────────

export async function acquireBoostLock(_env: Env, _boostId: string, _fingerprint: string) {
  return { acquired: true };
}
export async function releaseBoostLock(_env: Env): Promise<void> {}

// ─── ensureDiscoveryAlarm stub (handled by scheduler.ts) ─────────────────────
export async function ensureDiscoveryAlarm(_env: Env): Promise<void> {
  // No-op on Railway — scheduler.ts handles this independently
}
