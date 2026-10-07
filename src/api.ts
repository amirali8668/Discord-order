/**
 * api.ts — Railway version.
 * Same routes as Cloudflare version but:
 *  - Uses PostgreSQL (env.DB: Pool) instead of D1 (.prepare/.bind)
 *  - Uses state.ts kvGet/kvPut instead of BOT_STATE KV namespace
 *  - Replaces request.json<T>() with (await request.json()) as T
 *  - Session token stored via state.ts helpers
 */

import type { Env, BotConfig, BoostStatus, AcceptanceMethod } from "./types.js";
import { CHARACTER_TYPES, type CharacterType } from "./types.js";

import {
  getConfig, saveConfig, getLogs, clearLogs,
  getBotEnabled, setBotEnabled, getMessageCount, getAutoApprove,
  getAwaitingApproval, getPendingTargets, resetBotState,
  saveAwaitingApproval, saveAutoApprove, saveUsersReceivedMain, getUsersReceivedMain,
  addLog, getSessionToken, setSessionToken, deleteSessionToken,
} from "./state.js";
import { openDmChannel, sendMessage } from "./discord.js";

import {
  getAllGuilds, deleteGuild,
  getAllCategories, setCategoryMonitoring,
  getAllChannels,
  getAllBoosts, getBoost, getSentBoosts,
  getAllAcceptances,
  getMonitoringConfig, updateMonitoringConfig,
  getTelegramConfig, updateTelegramConfig,
  getMplusLogs, clearMplusLogs,
  getDashboardStats, insertMplusLog,
  setPausedForConfirmation, setLastAcceptedBoost,
  getGuildCharacterTypes, upsertGuildCharacterTypes,
} from "./db.js";
import { rowToConfig } from "./monitor.js";
import {
  enableMonitoring, disableMonitoring, getMonitoringState, resumeAfterAcceptance,
} from "./boost-machine.js";
import { resolveAndRegister } from "./monitor.js";
import { sendTelegramTest } from "./telegram.js";
import { buildHealthReport } from "./health.js";
import { testNotificationChannel, sendDiscordAcceptanceNotification } from "./discord-notify.js";
import { getRateLimitStats } from "./discord-client.js";
import { runMonitorTick } from "./monitor.js";

// ─── Session ──────────────────────────────────────────────────────────────────

const SESSION_COOKIE   = "bot_session";
const SESSION_DURATION = 60 * 60 * 8; // 8 h in seconds

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hA, hB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const dA = new Uint8Array(hA), dB = new Uint8Array(hB);
  let diff = 0;
  for (let i = 0; i < dA.length; i++) diff |= dA[i] ^ dB[i];
  return diff === 0;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("Cookie") ?? "";
  const match  = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const stored = await getSessionToken(env);
  if (!stored) return false;
  return timingSafeEqual(match[1], stored);
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function j(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const ok    = (data: unknown = { ok: true }) => j(data);
const err   = (msg: string, status = 400)   => j({ error: msg }, status);
const unauth = ()                            => j({ error: "Unauthorized" }, 401);

function parseQS(url: URL) {
  return (key: string) => url.searchParams.get(key) ?? undefined;
}

// ─── Main router ──────────────────────────────────────────────────────────────

export async function handleApiRequest(
  request:  Request,
  env:      Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;
  const url    = new URL(request.url);
  const qs     = parseQS(url);

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (pathname === "/api/login" && method === "POST") {
    const body   = (await request.json()) as { password?: string };
    const valid  = await timingSafeEqual(body.password ?? "", env.PANEL_PASSWORD);
    if (!valid) {
      await new Promise((r) => setTimeout(r, 500));
      return err("Invalid password", 401);
    }
    const token  = generateSessionToken();
    await setSessionToken(env, token, SESSION_DURATION);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION}`);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (pathname === "/api/logout" && method === "POST") {
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    await deleteSessionToken(env);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (pathname === "/api/auth/check" && method === "GET") {
    return j({ authenticated: await isAuthenticated(request, env) });
  }

  if (!(await isAuthenticated(request, env))) return unauth();

  // ══════════════════════════════════════════════════════════════════════════
  // ── ORIGINAL BOT ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  if (pathname === "/api/status" && method === "GET") {
    const [enabled, awaiting, autoApprove, count] = await Promise.all([
      getBotEnabled(env), getAwaitingApproval(env), getAutoApprove(env), getMessageCount(env),
    ]);
    return ok({ enabled, autoApprove, messageCount: count, awaitingApproval: awaiting });
  }

  if (pathname === "/api/config") {
    if (method === "GET")  return ok(await getConfig(env));
    if (method === "POST") {
      const body = (await request.json()) as Partial<BotConfig>;
      const cur  = await getConfig(env);
      await saveConfig(env, {
        channels:              body.channels              ?? cur.channels,
        response_message:      body.response_message      ?? cur.response_message,
        gold_amount:           body.gold_amount           ?? cur.gold_amount,
        targets:               body.targets               ?? cur.targets,
        inventory_message:     body.inventory_message     ?? cur.inventory_message,
        inventory_enabled:     body.inventory_enabled     ?? cur.inventory_enabled,
        keywords_all:          body.keywords_all          ?? cur.keywords_all,
        keyword_single:        body.keyword_single        ?? cur.keyword_single,
        banned_keywords:       body.banned_keywords       ?? cur.banned_keywords,
        poll_limit:            body.poll_limit            ?? cur.poll_limit,
        ping_interval_seconds: body.ping_interval_seconds ?? cur.ping_interval_seconds,
      });
      await addLog(env, "info", "Config updated via panel.");
      return ok();
    }
  }

  if (pathname === "/api/logs" && method === "GET") {
    return ok({ logs: (await getLogs(env)).slice().reverse() });
  }
  if (pathname === "/api/logs/clear" && method === "POST") {
    await clearLogs(env); return ok();
  }
  if (pathname === "/api/state" && method === "GET") {
    const [pt, urm, aw] = await Promise.all([
      getPendingTargets(env), getUsersReceivedMain(env), getAwaitingApproval(env),
    ]);
    return ok({ pendingTargets: pt, usersReceivedMainCount: urm.size, awaitingApproval: aw });
  }

  if (pathname === "/api/bot/enable"  && method === "POST") { await setBotEnabled(env, true);  await addLog(env, "success", "Bot enabled.");  return ok(); }
  if (pathname === "/api/bot/disable" && method === "POST") { await setBotEnabled(env, false); await addLog(env, "warn",    "Bot disabled."); return ok(); }
  if (pathname === "/api/bot/reset"   && method === "POST") { await resetBotState(env);         await addLog(env, "info",    "State reset.");   return ok(); }

  if (pathname === "/api/bot/approve" && method === "POST") {
    const aw = await getAwaitingApproval(env);
    if (!aw) return err("No pending approval");
    const cfg  = await getConfig(env);
    const dmCh = await openDmChannel(env, aw.author_id);
    if (dmCh) {
      await sendMessage(env, dmCh, `${cfg.response_message}\nGold: ${cfg.gold_amount}`);
      const u = await getUsersReceivedMain(env); u.add(aw.author_id);
      await saveUsersReceivedMain(env, u);
    }
    await saveAwaitingApproval(env, null);
    await saveAutoApprove(env, true);
    await addLog(env, "success", `Approved message to ${aw.author_id}.`);
    return ok();
  }
  if (pathname === "/api/bot/deny" && method === "POST") {
    const aw = await getAwaitingApproval(env);
    if (!aw) return err("No pending approval");
    await saveAwaitingApproval(env, null);
    await saveAutoApprove(env, false);
    await addLog(env, "warn", `Denied message to ${aw.author_id}.`);
    return ok();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── M+ MONITORING ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  if (pathname === "/api/monitor/status" && method === "GET") {
    const cfgRow = await getMonitoringConfig(env);
    const config = rowToConfig(cfgRow);
    const [state, sentBoosts] = await Promise.all([
      getMonitoringState(env, config), getSentBoosts(env),
    ]);
    let lastAccepted = null;
    if (config.lastAcceptedBoostId) lastAccepted = await getBoost(env, config.lastAcceptedBoostId);
    return ok({ state, sentBoosts, lastAcceptedBoost: lastAccepted, config });
  }

  if (pathname === "/api/monitor/enable"  && method === "POST") { await enableMonitoring(env);  return ok(); }
  if (pathname === "/api/monitor/disable" && method === "POST") { await disableMonitoring(env); return ok(); }

  if ((pathname === "/api/monitor/resume" || pathname === "/api/monitor/continue") && method === "POST") {
    await resumeAfterAcceptance(env); return ok();
  }

  if (pathname === "/api/monitor/force-release" && method === "POST") {
    await setPausedForConfirmation(env, false);
    await setLastAcceptedBoost(env, null);
    await env.DB.query(
      `UPDATE boosts SET status='ERROR' WHERE status IN ('SENT','WAITING')`
    ).catch(() => {});
    await insertMplusLog(env, "warn", "SYSTEM", "Force-released stuck state via panel.");
    return ok();
  }

  if (pathname === "/api/monitor/config") {
    if (method === "GET") return ok(await getMonitoringConfig(env));
    if (method === "POST") {
      const body  = (await request.json()) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};

      if (body.min_level !== undefined) {
        const v = Number(body.min_level);
        if (!Number.isInteger(v) || v < 1) return err("min_level must be a positive integer");
        patch.min_level = v;
      }
      if (body.max_level !== undefined) {
        const v = Number(body.max_level);
        if (!Number.isInteger(v) || v < 1) return err("max_level must be a positive integer");
        patch.max_level = v;
      }
      if (patch.min_level !== undefined && patch.max_level !== undefined &&
        (patch.min_level as number) > (patch.max_level as number))
        return err("min_level must be <= max_level");
      if (body.message_template !== undefined) {
        const t = String(body.message_template).trim();
        if (!t) return err("message_template cannot be empty");
        patch.message_template = t;
      }
      if (body.acceptance_mode !== undefined) {
        if (!["ANY","ALL"].includes(String(body.acceptance_mode))) return err("acceptance_mode must be ANY or ALL");
        patch.acceptance_mode = body.acceptance_mode;
      }
      if (body.accepted_reactions !== undefined) patch.accepted_reactions = String(body.accepted_reactions);
      if (body.mention_target_id  !== undefined) patch.mention_target_id  = body.mention_target_id ? String(body.mention_target_id) : null;
      if (body.accept_reaction    !== undefined) patch.accept_reaction    = body.accept_reaction    ? 1 : 0;
      if (body.accept_mention     !== undefined) patch.accept_mention     = body.accept_mention     ? 1 : 0;
      if (body.any_reaction_accepted !== undefined) patch.any_reaction_accepted = body.any_reaction_accepted ? 1 : 0;
      if (body.paused_after_accept   !== undefined) patch.paused_after_accept   = body.paused_after_accept   ? 1 : 0;
      if (body.notification_channel_id !== undefined)
        patch.notification_channel_id = body.notification_channel_id ? String(body.notification_channel_id) : null;
      if (body.discovery_interval_sec !== undefined) {
        const v = Number(body.discovery_interval_sec);
        if (!Number.isInteger(v) || v < 1 || v > 300) return err("discovery_interval_sec must be 1–300");
        patch.discovery_interval_sec = v;
      }
      if (body.sign_delay_sec !== undefined) {
        const v = Number(body.sign_delay_sec);
        if (!Number.isInteger(v) || v < 0 || v > 60) return err("sign_delay_sec must be 0–60");
        patch.sign_delay_sec = v;
      }
      if (body.queue_delay_sec !== undefined) {
        const v = Number(body.queue_delay_sec);
        if (!Number.isInteger(v) || v < 1 || v > 60) return err("queue_delay_sec must be 1–60");
        patch.queue_delay_sec = v;
      }
      await updateMonitoringConfig(env, patch as Parameters<typeof updateMonitoringConfig>[1]);
      await insertMplusLog(env, "info", "CONFIG_CHANGED", "Monitor config updated via panel.");
      return ok();
    }
  }

  if (pathname === "/api/monitor/resolve" && method === "POST") {
    const body      = (await request.json()) as { id?: string };
    const discordId = (body.id ?? "").trim();
    if (!discordId) return err("id is required");
    if (!/^\d{17,21}$/.test(discordId)) return err("Invalid Discord ID format");
    try {
      const cfgRow = await getMonitoringConfig(env);
      const config = rowToConfig(cfgRow);
      const result = await resolveAndRegister(env, discordId, config);
      return ok(result);
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  // ── Delete monitoring ─────────────────────────────────────────────────────
  const guildDelMatch = pathname.match(/^\/api\/monitor\/guild\/(\d{17,21})$/);
  if (guildDelMatch && method === "DELETE") {
    const guildId = guildDelMatch[1];
    await deleteGuild(env, guildId);
    await insertMplusLog(env, "info", "CONFIG_CHANGED", `Guild ${guildId} removed.`, { guildId });
    return ok();
  }

  const catDelMatch = pathname.match(/^\/api\/monitor\/category\/(\d{17,21})$/);
  if (catDelMatch && method === "DELETE") {
    const catId = catDelMatch[1];
    await setCategoryMonitoring(env, catId, false);
    await env.DB.query(
      `UPDATE channels SET monitoring=0, updated_at=$1 WHERE category_id=$2`,
      [Math.floor(Date.now()/1000), catId]
    );
    await insertMplusLog(env, "info", "CONFIG_CHANGED", `Category ${catId} removed.`);
    return ok();
  }

  const chDelMatch = pathname.match(/^\/api\/monitor\/channel\/(\d{17,21})$/);
  if (chDelMatch && method === "DELETE") {
    const chId = chDelMatch[1];
    await env.DB.query(
      `UPDATE channels SET monitoring=0, updated_at=$1 WHERE id=$2`,
      [Math.floor(Date.now()/1000), chId]
    );
    await env.DB.query(
      `UPDATE boosts SET status='EXPIRED' WHERE channel_id=$1 AND status IN ('SENT','WAITING')`,
      [chId]
    ).catch(() => {});
    await insertMplusLog(env, "info", "CONFIG_CHANGED", `Channel ${chId} removed.`, { channelId: chId });
    return ok();
  }

  // ── Guilds ────────────────────────────────────────────────────────────────
  if (pathname === "/api/guilds" && method === "GET") {
    const guilds   = await getAllGuilds(env);
    const enriched = await Promise.all(guilds.map(async (g) => {
      const [cats, chs, charCfg] = await Promise.all([
        env.DB.query(`SELECT COUNT(*) AS n FROM categories WHERE guild_id=$1`, [g.id]).then(r => ({ n: parseInt(r.rows[0]?.n ?? "0") })),
        env.DB.query(`SELECT COUNT(*) AS n FROM channels WHERE guild_id=$1 AND active=1`, [g.id]).then(r => ({ n: parseInt(r.rows[0]?.n ?? "0") })),
        getGuildCharacterTypes(env, g.id),
      ]);
      return { ...g, category_count: cats.n, channel_count: chs.n, char_allow_all: charCfg.allowAll, char_enabled: charCfg.enabledTypes };
    }));
    return ok(enriched);
  }

  // Guild character types
  const guildCharGet  = pathname.match(/^\/api\/guilds\/(\d{17,21})\/char-types$/);
  if (guildCharGet  && method === "GET") {
    const config = await getGuildCharacterTypes(env, guildCharGet[1]);
    return ok({ ...config, supportedTypes: CHARACTER_TYPES });
  }
  const guildCharPost = pathname.match(/^\/api\/guilds\/(\d{17,21})\/char-types$/);
  if (guildCharPost && method === "POST") {
    const guildId  = guildCharPost[1];
    const body     = (await request.json()) as { allow_all?: boolean; enabled_types?: string[] };
    const allowAll = body.allow_all === true;
    const rawTypes = Array.isArray(body.enabled_types) ? body.enabled_types : [];
    const validTypes = rawTypes
      .filter((t): t is CharacterType => (CHARACTER_TYPES as readonly string[]).includes(String(t).toLowerCase()))
      .map((t) => t.toLowerCase() as CharacterType);
    await upsertGuildCharacterTypes(env, guildId, validTypes, allowAll);
    await insertMplusLog(env, "info", "CONFIG_CHANGED", `Guild ${guildId} char types updated.`, { guildId });
    return ok();
  }

  if (pathname === "/api/categories" && method === "GET") {
    const guildId = qs("guildId");
    let cats = await getAllCategories(env);
    if (guildId) cats = cats.filter((c) => c.guild_id === guildId);
    return ok(cats);
  }

  if (pathname === "/api/channels" && method === "GET") {
    const channels = await getAllChannels(env, { guildId: qs("guildId"), categoryId: qs("categoryId"), active: qs("active") !== undefined ? qs("active") !== "false" : undefined });
    return ok(channels);
  }

  if (pathname === "/api/boosts" && method === "GET") {
    const boosts = await getAllBoosts(env, {
      status:    qs("status") as BoostStatus | undefined,
      guildId:   qs("guildId"), channelId: qs("channelId"), customer: qs("customer"),
      minLevel:  qs("minLevel")  ? Number(qs("minLevel"))  : undefined,
      maxLevel:  qs("maxLevel")  ? Number(qs("maxLevel"))  : undefined,
      since:     qs("since")     ? Number(qs("since"))     : undefined,
      limit:     qs("limit")     ? Number(qs("limit"))     : 100,
      offset:    qs("offset")    ? Number(qs("offset"))    : 0,
    });
    return ok(boosts);
  }

  const boostGetMatch = pathname.match(/^\/api\/boosts\/([^/]+)$/);
  if (boostGetMatch && method === "GET") {
    const boost = await getBoost(env, boostGetMatch[1]);
    if (!boost) return err("Not found", 404);
    return ok(boost);
  }

  if (pathname === "/api/accepts" && method === "GET") {
    const accepts = await getAllAcceptances(env, {
      boostId: qs("boostId"), method: qs("method") as AcceptanceMethod | undefined,
      since: qs("since") ? Number(qs("since")) : undefined,
      limit: qs("limit") ? Number(qs("limit")) : 100,
      offset: qs("offset") ? Number(qs("offset")) : 0,
    });
    return ok(accepts);
  }

  if (pathname === "/api/mplus/logs" && method === "GET") {
    const logs = await getMplusLogs(env, {
      level: qs("level"), eventType: qs("eventType"), guildId: qs("guildId"),
      channelId: qs("channelId"), boostId: qs("boostId"), search: qs("search"),
      since: qs("since") ? Number(qs("since")) : undefined,
      until: qs("until") ? Number(qs("until")) : undefined,
      limit: qs("limit") ? Number(qs("limit")) : 200,
      offset: qs("offset") ? Number(qs("offset")) : 0,
    });
    return ok(logs);
  }
  if (pathname === "/api/mplus/logs/clear" && method === "POST") {
    await clearMplusLogs(env); return ok();
  }

  if (pathname === "/api/dashboard/stats" && method === "GET") {
    const stats   = await getDashboardStats(env);
    const cfgRow  = await getMonitoringConfig(env);
    const config  = rowToConfig(cfgRow);
    const state   = await getMonitoringState(env, config);
    const sentBoosts = await getSentBoosts(env);
    let lastAccepted = null;
    if (config.lastAcceptedBoostId) lastAccepted = await getBoost(env, config.lastAcceptedBoostId);
    return ok({ ...stats, monitoringState: state, sentBoosts, sentBoostCount: sentBoosts.length, lastAcceptedBoost: lastAccepted, pausedForConfirmation: config.pausedForConfirmation, notificationChannelId: config.notificationChannelId });
  }

  if (pathname === "/api/telegram/config") {
    if (method === "GET") {
      const row = await getTelegramConfig(env);
      return ok({ chat_id: row.chat_id, alert_boost_accepted: row.alert_boost_accepted, alert_new_boost: row.alert_new_boost, alert_new_channel: row.alert_new_channel, alert_errors: row.alert_errors, has_token: !!(env.TELEGRAM_TOKEN) });
    }
    if (method === "POST") {
      const body  = (await request.json()) as Record<string, unknown>;
      const patch: Parameters<typeof updateTelegramConfig>[1] = {};
      if (body.chat_id !== undefined)             patch.chat_id             = body.chat_id ? String(body.chat_id) : null;
      if (body.alert_boost_accepted !== undefined) patch.alert_boost_accepted = body.alert_boost_accepted ? 1 : 0;
      if (body.alert_new_boost      !== undefined) patch.alert_new_boost      = body.alert_new_boost      ? 1 : 0;
      if (body.alert_new_channel    !== undefined) patch.alert_new_channel    = body.alert_new_channel    ? 1 : 0;
      if (body.alert_errors         !== undefined) patch.alert_errors         = body.alert_errors         ? 1 : 0;
      await updateTelegramConfig(env, patch);
      return ok();
    }
  }

  if (pathname === "/api/discord/status" && method === "GET") {
    const stats = getRateLimitStats();
    return ok({ ...stats, lastRateLimitAt: stats.lastRateLimit ? new Date(stats.lastRateLimit).toISOString() : null });
  }

  if (pathname === "/api/monitor/trigger" && method === "POST") {
    try {
      await runMonitorTick(env);
      await insertMplusLog(env, "info", "SYSTEM", "Manual monitor tick triggered.");
      return ok({ message: "Monitor tick executed" });
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  if (pathname === "/api/monitor/retry-notification" && method === "POST") {
    const cfgRow = await getMonitoringConfig(env);
    const config = rowToConfig(cfgRow);
    if (!config.lastAcceptedBoostId)   return err("No accepted boost to retry");
    if (!config.notificationChannelId) return err("Notification channel not configured");
    await env.DB.query(`UPDATE boosts SET notif_sent=0 WHERE id=$1`, [config.lastAcceptedBoostId]).catch(() => {});
    try {
      await sendDiscordAcceptanceNotification(env, config.lastAcceptedBoostId, config.notificationChannelId);
      return ok({ message: "Notification retried" });
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  if (pathname === "/api/monitor/test-notification" && method === "POST") {
    const cfgRow = await getMonitoringConfig(env);
    const config = rowToConfig(cfgRow);
    if (!config.notificationChannelId) return err("Notification channel not configured");
    const result = await testNotificationChannel(env, config.notificationChannelId);
    return j(result, result.ok ? 200 : 502);
  }

  if (pathname === "/api/telegram/test" && method === "POST") {
    const token = env.TELEGRAM_TOKEN;
    if (!token) return err("TELEGRAM_TOKEN secret is not set");
    const row = await getTelegramConfig(env);
    if (!row.chat_id) return err("Telegram chat_id is not configured");
    const result = await sendTelegramTest(token, row.chat_id);
    return j(result, result.ok ? 200 : 502);
  }

  if (pathname === "/api/health" && method === "GET") {
    const { report, httpStatus } = await buildHealthReport(env);
    return j(report, httpStatus);
  }

  return null;
}
