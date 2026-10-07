/**
 * health.ts — Railway version.
 * Lightweight health check — no expensive Discord API calls.
 */

import type { Env } from "./types.js";
import { getMonitoringConfig, getTelegramConfig } from "./db.js";
import { getRateLimitStats } from "./discord-client.js";
import { rowToConfig } from "./monitor.js";

export async function buildHealthReport(env: Env): Promise<{ report: Record<string,unknown>; httpStatus: number }> {
  const rl = getRateLimitStats();
  const report: Record<string, unknown> = {
    status:    "ok",
    timestamp: new Date().toISOString(),
    db:        "ok",
    monitoring_state:   "UNKNOWN",
    monitoring_enabled: false,
    telegram_token_set: !!env.TELEGRAM_TOKEN,
    telegram_chat_configured: false,
    discord_api: {
      totalRequests:  rl.totalRequests,
      total429s:      rl.total429s,
      failedRequests: rl.failedRequests,
      cacheSize:      rl.cacheSize,
      status: rl.total429s > 0 ? "rate_limited" : rl.failedRequests > 5 ? "degraded" : "ok",
    },
    uptime_note: "Railway long-running service.",
  };

  // DB check
  try {
    const cfg = await getMonitoringConfig(env);
    const c   = rowToConfig(cfg);
    report.monitoring_enabled = c.enabled;
    report.monitoring_state   = c.enabled ? "ACTIVE" : "INACTIVE";
  } catch {
    report.db = "error";
    report.status = "degraded";
  }

  // Telegram
  try {
    const tg = await getTelegramConfig(env);
    report.telegram_chat_configured = !!tg.chat_id;
  } catch {}

  if ((report.discord_api as Record<string,unknown>)?.status !== "ok") {
    report.status = "degraded";
  }

  const httpStatus = report.status === "ok" ? 200 : 503;
  return { report, httpStatus };
}
