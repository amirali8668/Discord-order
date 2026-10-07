/**
 * state.ts — Railway version.
 * Replaces Cloudflare KV with kv_store PostgreSQL table via db.ts kvGet/kvPut.
 */

import type { Env, BotConfig, BotLog, PendingTarget, AwaitingApproval } from "./types.js";
import { DEFAULT_BOT_CONFIG } from "./types.js";
import { kvGet, kvPut } from "./db.js";

const MAX_SEEN = 500;
const MAX_LOGS = 200;

const K = {
  CONFIG:              "config",
  SEEN_MESSAGES:       "seen_messages",
  PENDING_TARGETS:     "pending_targets",
  INVENTORY_SENT:      "inventory_sent",
  USERS_RECEIVED_MAIN: "users_received_main",
  MESSAGE_COUNT:       "message_count",
  AUTO_APPROVE:        "auto_approve",
  AWAITING_APPROVAL:   "awaiting_approval",
  BOT_LOGS:            "bot_logs",
  BOT_ENABLED:         "bot_enabled",
  SESSION_TOKEN:       "session_token",
} as const;

export async function getConfig(env: Env): Promise<BotConfig> {
  return kvGet<BotConfig>(env, K.CONFIG, DEFAULT_BOT_CONFIG);
}
export async function saveConfig(env: Env, cfg: BotConfig): Promise<void> {
  await kvPut(env, K.CONFIG, cfg);
}

export async function getSeenMessages(env: Env): Promise<Set<string>> {
  const arr = await kvGet<string[]>(env, K.SEEN_MESSAGES, []);
  return new Set(arr);
}
export async function saveSeenMessages(env: Env, seen: Set<string>): Promise<void> {
  await kvPut(env, K.SEEN_MESSAGES, [...seen].slice(-MAX_SEEN));
}

export async function getPendingTargets(env: Env): Promise<Record<string, PendingTarget>> {
  return kvGet<Record<string, PendingTarget>>(env, K.PENDING_TARGETS, {});
}
export async function savePendingTargets(env: Env, t: Record<string, PendingTarget>): Promise<void> {
  await kvPut(env, K.PENDING_TARGETS, t);
}

export async function getInventorySent(env: Env): Promise<Set<string>> {
  const arr = await kvGet<string[]>(env, K.INVENTORY_SENT, []);
  return new Set(arr);
}
export async function saveInventorySent(env: Env, s: Set<string>): Promise<void> {
  await kvPut(env, K.INVENTORY_SENT, [...s]);
}

export async function getUsersReceivedMain(env: Env): Promise<Set<string>> {
  const arr = await kvGet<string[]>(env, K.USERS_RECEIVED_MAIN, []);
  return new Set(arr);
}
export async function saveUsersReceivedMain(env: Env, u: Set<string>): Promise<void> {
  await kvPut(env, K.USERS_RECEIVED_MAIN, [...u]);
}

export async function getMessageCount(env: Env): Promise<number> {
  return kvGet<number>(env, K.MESSAGE_COUNT, 0);
}
export async function saveMessageCount(env: Env, n: number): Promise<void> {
  await kvPut(env, K.MESSAGE_COUNT, n);
}

export async function getAutoApprove(env: Env): Promise<boolean> {
  return kvGet<boolean>(env, K.AUTO_APPROVE, true);
}
export async function saveAutoApprove(env: Env, v: boolean): Promise<void> {
  await kvPut(env, K.AUTO_APPROVE, v);
}

export async function getAwaitingApproval(env: Env): Promise<AwaitingApproval | null> {
  return kvGet<AwaitingApproval | null>(env, K.AWAITING_APPROVAL, null);
}
export async function saveAwaitingApproval(env: Env, d: AwaitingApproval | null): Promise<void> {
  await kvPut(env, K.AWAITING_APPROVAL, d);
}

export async function getBotEnabled(env: Env): Promise<boolean> {
  return kvGet<boolean>(env, K.BOT_ENABLED, true);
}
export async function setBotEnabled(env: Env, v: boolean): Promise<void> {
  await kvPut(env, K.BOT_ENABLED, v);
}

export async function getLogs(env: Env): Promise<BotLog[]> {
  return kvGet<BotLog[]>(env, K.BOT_LOGS, []);
}
export async function addLog(env: Env, level: BotLog["level"], message: string): Promise<void> {
  const logs = await getLogs(env);
  logs.push({ timestamp: Date.now(), level, message });
  await kvPut(env, K.BOT_LOGS, logs.slice(-MAX_LOGS));
}
export async function clearLogs(env: Env): Promise<void> {
  await kvPut(env, K.BOT_LOGS, []);
}

export async function resetBotState(env: Env): Promise<void> {
  await Promise.all([
    kvPut(env, K.SEEN_MESSAGES, []),
    kvPut(env, K.PENDING_TARGETS, {}),
    kvPut(env, K.INVENTORY_SENT, []),
    kvPut(env, K.USERS_RECEIVED_MAIN, []),
    kvPut(env, K.MESSAGE_COUNT, 0),
    kvPut(env, K.AUTO_APPROVE, true),
    kvPut(env, K.AWAITING_APPROVAL, null),
  ]);
}

// ── Session token helpers (for express-session fallback) ──────────────────────
export async function getSessionToken(env: Env): Promise<string | null> {
  return kvGet<string | null>(env, K.SESSION_TOKEN, null);
}
export async function setSessionToken(env: Env, token: string, _ttlSec?: number): Promise<void> {
  await kvPut(env, K.SESSION_TOKEN, token);
}
export async function deleteSessionToken(env: Env): Promise<void> {
  await kvPut(env, K.SESSION_TOKEN, null);
}
