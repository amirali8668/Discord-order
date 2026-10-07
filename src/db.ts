/**
 * db.ts — PostgreSQL persistence layer (Railway version).
 * Mirrors the Cloudflare D1 db.ts API surface exactly,
 * but uses `pg` Pool instead of D1Database.
 */

import type {
  Env, GuildRow, CategoryRow, ChannelRow, BoostRow, AcceptanceRow,
  MonitoringConfigRow, MplusLogRow,
  BoostStatus, AcceptanceMethod, LogEventType,
  GuildCharacterTypesRow,
} from "./types.js";
import { CHARACTER_TYPES } from "./types.js";
// Used only in function signatures/return types — kept for clarity
import type { CharacterType as _CharType, TelegramConfigRow as _TgRow, GuildCharacterTypesConfig as _GctCfg } from "./types.js";
import { Pool } from "pg";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function db(env: Env): Pool { return env.DB; }
function nowMs():  number { return Date.now(); }
function nowSec(): number { return Math.floor(Date.now() / 1000); }

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function qOne<T>(env: Env, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db(env).query(sql, params);
  return (r.rows[0] as T) ?? null;
}
async function qAll<T>(env: Env, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db(env).query(sql, params);
  return r.rows as T[];
}
async function qRun(env: Env, sql: string, params: unknown[] = []): Promise<void> {
  await db(env).query(sql, params);
}

// ─── KV store (replaces Cloudflare KV for original bot state) ─────────────────

export async function kvGet<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await qOne<{ value: string }>(env, "SELECT value FROM kv_store WHERE key=$1", [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}
export async function kvPut(env: Env, key: string, value: unknown): Promise<void> {
  await qRun(env,
    `INSERT INTO kv_store(key,value,updated_at) VALUES($1,$2,$3)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
    [key, JSON.stringify(value), nowSec()]
  );
}
export async function kvDelete(env: Env, key: string): Promise<void> {
  await qRun(env, "DELETE FROM kv_store WHERE key=$1", [key]);
}

// ─── Guilds ───────────────────────────────────────────────────────────────────

export async function upsertGuild(env: Env, id: string, name: string, icon: string | null = null): Promise<void> {
  await qRun(env,
    `INSERT INTO guilds(id,name,icon,updated_at) VALUES($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon, updated_at=EXCLUDED.updated_at`,
    [id, name, icon, nowSec()]
  );
}
export async function setGuildMonitoring(env: Env, guildId: string, monitoring: boolean): Promise<void> {
  await qRun(env, "UPDATE guilds SET monitoring=$1, updated_at=$2 WHERE id=$3", [monitoring?1:0, nowSec(), guildId]);
}
export async function getGuild(env: Env, id: string): Promise<GuildRow | null> {
  return qOne<GuildRow>(env, "SELECT * FROM guilds WHERE id=$1", [id]);
}
export async function getAllGuilds(env: Env): Promise<GuildRow[]> {
  return qAll<GuildRow>(env, "SELECT * FROM guilds ORDER BY name");
}
export async function getMonitoredGuilds(env: Env): Promise<GuildRow[]> {
  return qAll<GuildRow>(env, "SELECT * FROM guilds WHERE monitoring=1");
}
export async function touchGuild(env: Env, guildId: string): Promise<void> {
  await qRun(env, "UPDATE guilds SET last_event_at=$1, updated_at=$2 WHERE id=$3", [nowSec(), nowSec(), guildId]);
}
export async function deleteGuild(env: Env, guildId: string): Promise<void> {
  // FK cascades handle categories/channels/boosts
  await qRun(env, "DELETE FROM guilds WHERE id=$1", [guildId]);
}

// ─── Categories ───────────────────────────────────────────────────────────────

export async function upsertCategory(env: Env, id: string, guildId: string, name: string): Promise<void> {
  await qRun(env,
    `INSERT INTO categories(id,guild_id,name,updated_at) VALUES($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET guild_id=EXCLUDED.guild_id, name=EXCLUDED.name, updated_at=EXCLUDED.updated_at`,
    [id, guildId, name, nowSec()]
  );
}
export async function setCategoryMonitoring(env: Env, categoryId: string, monitoring: boolean): Promise<void> {
  await qRun(env, "UPDATE categories SET monitoring=$1, updated_at=$2 WHERE id=$3", [monitoring?1:0, nowSec(), categoryId]);
}
export async function getCategory(env: Env, id: string): Promise<CategoryRow | null> {
  return qOne<CategoryRow>(env, "SELECT * FROM categories WHERE id=$1", [id]);
}
export async function getAllCategories(env: Env): Promise<CategoryRow[]> {
  return qAll<CategoryRow>(env, "SELECT * FROM categories ORDER BY name");
}
export async function getMonitoredCategories(env: Env): Promise<CategoryRow[]> {
  return qAll<CategoryRow>(env, "SELECT * FROM categories WHERE monitoring=1");
}

// ─── Channels ─────────────────────────────────────────────────────────────────

export async function upsertChannel(env: Env, row: Omit<ChannelRow,"created_at"|"updated_at">): Promise<void> {
  await qRun(env,
    `INSERT INTO channels(id,guild_id,guild_name,category_id,category_name,name,channel_type,
       parsed,boost_type,boost_count,boost_level,customer,parse_status,active,monitoring,
       in_level_range,last_event_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT(id) DO UPDATE SET
       guild_id=EXCLUDED.guild_id, guild_name=EXCLUDED.guild_name,
       category_id=EXCLUDED.category_id, category_name=EXCLUDED.category_name,
       name=EXCLUDED.name, channel_type=EXCLUDED.channel_type,
       parsed=EXCLUDED.parsed, boost_type=EXCLUDED.boost_type,
       boost_count=EXCLUDED.boost_count, boost_level=EXCLUDED.boost_level,
       customer=EXCLUDED.customer, parse_status=EXCLUDED.parse_status,
       active=EXCLUDED.active, monitoring=EXCLUDED.monitoring,
       in_level_range=EXCLUDED.in_level_range, last_event_at=EXCLUDED.last_event_at,
       updated_at=EXCLUDED.updated_at`,
    [row.id, row.guild_id, row.guild_name, row.category_id??null, row.category_name??null,
     row.name, row.channel_type, row.parsed, row.boost_type??null, row.boost_count??null,
     row.boost_level??null, row.customer??null, row.parse_status, row.active,
     row.monitoring, row.in_level_range, row.last_event_at??null, nowSec(), nowSec()]
  );
}
export async function markChannelDeleted(env: Env, channelId: string): Promise<void> {
  await qRun(env, "UPDATE channels SET active=0, monitoring=0, updated_at=$1 WHERE id=$2", [nowSec(), channelId]);
}
export async function getChannel(env: Env, id: string): Promise<ChannelRow | null> {
  return qOne<ChannelRow>(env, "SELECT * FROM channels WHERE id=$1", [id]);
}
export async function getActiveMonitoredChannels(env: Env): Promise<ChannelRow[]> {
  return qAll<ChannelRow>(env,
    "SELECT * FROM channels WHERE active=1 AND monitoring=1 AND in_level_range=1 AND parsed=1"
  );
}
export async function getAllChannels(env: Env, filters?: { guildId?: string; categoryId?: string; active?: boolean }): Promise<ChannelRow[]> {
  const params: unknown[] = [];
  let sql = "SELECT * FROM channels WHERE 1=1";
  if (filters?.guildId)    { params.push(filters.guildId);    sql += ` AND guild_id=$${params.length}`; }
  if (filters?.categoryId) { params.push(filters.categoryId); sql += ` AND category_id=$${params.length}`; }
  if (filters?.active !== undefined) { params.push(filters.active?1:0); sql += ` AND active=$${params.length}`; }
  sql += " ORDER BY name";
  return qAll<ChannelRow>(env, sql, params);
}

// ─── Boosts ───────────────────────────────────────────────────────────────────

export async function createBoost(env: Env, row: Omit<BoostRow,"sent_at"|"accepted_at"|"acceptance_method"|"accepted_by_user_id"|"accepted_by_username"|"accepted_reaction"|"acceptance_message_id"|"outgoing_message_id"|"outgoing_message_content">): Promise<void> {
  await qRun(env,
    `INSERT INTO boosts(id,guild_id,guild_name,category_id,category_name,channel_id,
       channel_name,customer,level,count,boost_type,fingerprint,
       outgoing_message_id,outgoing_message_content,status,created_at,notif_sent)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NULL,$13,$14,$15)
     ON CONFLICT(id) DO NOTHING`,
    [row.id, row.guild_id, row.guild_name, row.category_id??null, row.category_name??null,
     row.channel_id, row.channel_name, row.customer, row.level, row.count,
     row.boost_type, row.fingerprint, row.status, row.created_at, row.notif_sent]
  );
}
export async function updateBoostStatus(env: Env, boostId: string, status: BoostStatus): Promise<void> {
  await qRun(env, "UPDATE boosts SET status=$1 WHERE id=$2", [status, boostId]);
}
export async function updateBoostSent(env: Env, boostId: string, outgoingMessageId: string, content: string): Promise<void> {
  await qRun(env,
    "UPDATE boosts SET outgoing_message_id=$1, outgoing_message_content=$2, sent_at=$3, status='SENT' WHERE id=$4",
    [outgoingMessageId, content, nowMs(), boostId]
  );
}
export async function updateBoostAccepted(env: Env, boostId: string, method: AcceptanceMethod, userId: string, username: string | null, reaction: string | null, acceptanceMessageId: string | null): Promise<void> {
  await qRun(env,
    `UPDATE boosts SET status='ACCEPTED', accepted_at=$1, acceptance_method=$2,
     accepted_by_user_id=$3, accepted_by_username=$4, accepted_reaction=$5, acceptance_message_id=$6
     WHERE id=$7`,
    [nowMs(), method, userId, username, reaction, acceptanceMessageId, boostId]
  );
}
export async function getBoost(env: Env, id: string): Promise<BoostRow | null> {
  return qOne<BoostRow>(env, "SELECT * FROM boosts WHERE id=$1", [id]);
}
export async function getSentBoosts(env: Env): Promise<BoostRow[]> {
  return qAll<BoostRow>(env, "SELECT * FROM boosts WHERE status IN ('SENT','WAITING') ORDER BY created_at ASC");
}
export async function getBoostByFingerprint(env: Env, fingerprint: string): Promise<BoostRow | null> {
  return qOne<BoostRow>(env, "SELECT * FROM boosts WHERE fingerprint=$1", [fingerprint]);
}
export async function getBoostByOutgoingMessageId(env: Env, msgId: string): Promise<BoostRow | null> {
  return qOne<BoostRow>(env, "SELECT * FROM boosts WHERE outgoing_message_id=$1", [msgId]);
}
export async function getSentBoostForChannel(env: Env, channelId: string): Promise<BoostRow | null> {
  return qOne<BoostRow>(env, "SELECT * FROM boosts WHERE channel_id=$1 AND status IN ('SENT','WAITING') ORDER BY created_at ASC LIMIT 1", [channelId]);
}
export async function getWaitingBoost(env: Env): Promise<BoostRow | null> {
  return qOne<BoostRow>(env, "SELECT * FROM boosts WHERE status IN ('SENT','WAITING') LIMIT 1");
}
export async function markNotifSent(env: Env, boostId: string): Promise<void> {
  await qRun(env, "UPDATE boosts SET notif_sent=1 WHERE id=$1", [boostId]);
}
export async function acceptanceExistsForBoost(env: Env, boostId: string): Promise<boolean> {
  const r = await qOne<{id:string}>(env, "SELECT id FROM acceptances WHERE boost_id=$1 LIMIT 1", [boostId]);
  return r !== null;
}
export async function acceptanceExistsForMethod(env: Env, boostId: string, method: AcceptanceMethod): Promise<boolean> {
  const r = await qOne<{id:string}>(env, "SELECT id FROM acceptances WHERE boost_id=$1 AND method=$2 LIMIT 1", [boostId, method]);
  return r !== null;
}
export async function getAllBoosts(env: Env, filters?: { status?: BoostStatus; guildId?: string; channelId?: string; customer?: string; minLevel?: number; maxLevel?: number; since?: number; limit?: number; offset?: number }): Promise<BoostRow[]> {
  const params: unknown[] = [];
  let sql = "SELECT * FROM boosts WHERE 1=1";
  if (filters?.status)   { params.push(filters.status);    sql += ` AND status=$${params.length}`; }
  if (filters?.guildId)  { params.push(filters.guildId);   sql += ` AND guild_id=$${params.length}`; }
  if (filters?.channelId){ params.push(filters.channelId); sql += ` AND channel_id=$${params.length}`; }
  if (filters?.customer) { params.push(`%${filters.customer}%`); sql += ` AND customer ILIKE $${params.length}`; }
  if (filters?.minLevel !== undefined) { params.push(filters.minLevel); sql += ` AND level>=$${params.length}`; }
  if (filters?.maxLevel !== undefined) { params.push(filters.maxLevel); sql += ` AND level<=$${params.length}`; }
  if (filters?.since)    { params.push(filters.since);     sql += ` AND created_at>=$${params.length}`; }
  sql += " ORDER BY created_at DESC";
  params.push(filters?.limit??100, filters?.offset??0);
  sql += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
  return qAll<BoostRow>(env, sql, params);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function insertMessage(env: Env, messageId: string, boostId: string, guildId: string, categoryId: string | null, channelId: string, content: string): Promise<void> {
  await qRun(env,
    `INSERT INTO messages(id,boost_id,guild_id,category_id,channel_id,content,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
    [messageId, boostId, guildId, categoryId, channelId, content, nowMs()]
  );
}

// ─── Acceptances ──────────────────────────────────────────────────────────────

export async function createAcceptance(env: Env, row: Omit<AcceptanceRow,"id"> & { id?: string }): Promise<string> {
  const id = row.id ?? newId();
  await qRun(env,
    `INSERT INTO acceptances(id,boost_id,outgoing_message_id,channel_id,method,
       accepted_by_user_id,accepted_by_username,reaction_emoji,mention_message_id,mention_content,accepted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [id, row.boost_id, row.outgoing_message_id, row.channel_id, row.method,
     row.accepted_by_user_id, row.accepted_by_username??null, row.reaction_emoji??null,
     row.mention_message_id??null, row.mention_content??null, row.accepted_at]
  );
  return id;
}
export async function getAcceptancesForBoost(env: Env, boostId: string): Promise<AcceptanceRow[]> {
  return qAll<AcceptanceRow>(env, "SELECT * FROM acceptances WHERE boost_id=$1 ORDER BY accepted_at", [boostId]);
}
export async function getAllAcceptances(env: Env, filters?: { boostId?: string; method?: AcceptanceMethod; since?: number; limit?: number; offset?: number }): Promise<AcceptanceRow[]> {
  const params: unknown[] = [];
  let sql = "SELECT * FROM acceptances WHERE 1=1";
  if (filters?.boostId) { params.push(filters.boostId); sql += ` AND boost_id=$${params.length}`; }
  if (filters?.method)  { params.push(filters.method);  sql += ` AND method=$${params.length}`; }
  if (filters?.since)   { params.push(filters.since);   sql += ` AND accepted_at>=$${params.length}`; }
  sql += " ORDER BY accepted_at DESC";
  params.push(filters?.limit??100, filters?.offset??0);
  sql += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
  return qAll<AcceptanceRow>(env, sql, params);
}

// ─── Monitoring config ────────────────────────────────────────────────────────

export async function getMonitoringConfig(env: Env): Promise<MonitoringConfigRow> {
  const row = await qOne<MonitoringConfigRow>(env, "SELECT * FROM monitoring_config WHERE id=1");
  if (!row) throw new Error("monitoring_config singleton row missing — run migrations");
  return row;
}
export async function updateMonitoringConfig(env: Env, patch: Partial<Omit<MonitoringConfigRow,"id"|"updated_at">>): Promise<void> {
  const cur = await getMonitoringConfig(env);
  const m = { ...cur, ...patch };
  await qRun(env,
    `UPDATE monitoring_config SET
       enabled=$1, min_level=$2, max_level=$3, message_template=$4, acceptance_mode=$5,
       accepted_reactions=$6, mention_target_id=$7, accept_reaction=$8, accept_mention=$9,
       any_reaction_accepted=$10, paused_after_accept=$11, paused=$12,
       paused_for_confirmation=$13, last_accepted_boost_id=$14, notification_channel_id=$15,
       discovery_interval_sec=$16, sign_delay_sec=$17, queue_delay_sec=$18, updated_at=$19
     WHERE id=1`,
    [m.enabled, m.min_level, m.max_level, m.message_template, m.acceptance_mode,
     m.accepted_reactions, m.mention_target_id??null, m.accept_reaction, m.accept_mention,
     m.any_reaction_accepted??1, m.paused_after_accept??1, m.paused??0,
     m.paused_for_confirmation??0, m.last_accepted_boost_id??null, m.notification_channel_id??null,
     m.discovery_interval_sec??5, m.sign_delay_sec??3, m.queue_delay_sec??2, nowSec()]
  );
}
export async function setPausedForConfirmation(env: Env, paused: boolean): Promise<void> {
  await qRun(env, "UPDATE monitoring_config SET paused_for_confirmation=$1, updated_at=$2 WHERE id=1", [paused?1:0, nowSec()]);
}
export async function setLastAcceptedBoost(env: Env, boostId: string | null): Promise<void> {
  await qRun(env, "UPDATE monitoring_config SET last_accepted_boost_id=$1, updated_at=$2 WHERE id=1", [boostId, nowSec()]);
}
export async function pauseMonitoring(env: Env): Promise<void> {
  await qRun(env, "UPDATE monitoring_config SET paused=1, updated_at=$1 WHERE id=1", [nowSec()]);
}
export async function resumeMonitoring(env: Env): Promise<void> {
  await qRun(env, "UPDATE monitoring_config SET paused=0, updated_at=$1 WHERE id=1", [nowSec()]);
}

// ─── Telegram config ──────────────────────────────────────────────────────────

export async function getTelegramConfig(env: Env): Promise<import("./types.js").TelegramConfigRow> {
  const row = await qOne<import("./types.js").TelegramConfigRow>(env, "SELECT * FROM telegram_config WHERE id=1");
  if (!row) throw new Error("telegram_config singleton row missing — run migrations");
  return row;
}
export async function updateTelegramConfig(env: Env, patch: Partial<Omit<import("./types.js").TelegramConfigRow,"id"|"updated_at">>): Promise<void> {
  const cur = await getTelegramConfig(env);
  const m = { ...cur, ...patch };
  await qRun(env,
    `UPDATE telegram_config SET chat_id=$1, alert_boost_accepted=$2, alert_new_boost=$3,
       alert_new_channel=$4, alert_errors=$5, updated_at=$6 WHERE id=1`,
    [m.chat_id??null, m.alert_boost_accepted, m.alert_new_boost, m.alert_new_channel, m.alert_errors, nowSec()]
  );
}

// ─── M+ Logs ──────────────────────────────────────────────────────────────────

export async function insertMplusLog(env: Env, level: MplusLogRow["level"], eventType: LogEventType, message: string, opts?: { guildId?: string; channelId?: string; boostId?: string; context?: Record<string,unknown> }): Promise<void> {
  const id = newId();
  await qRun(env,
    "INSERT INTO mplus_logs(id,level,event_type,guild_id,channel_id,boost_id,message,context,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, level, eventType, opts?.guildId??null, opts?.channelId??null, opts?.boostId??null, message, opts?.context?JSON.stringify(opts.context):null, nowMs()]
  );
}
export async function getMplusLogs(env: Env, filters?: { level?: string; eventType?: string; guildId?: string; channelId?: string; boostId?: string; search?: string; since?: number; until?: number; limit?: number; offset?: number }): Promise<MplusLogRow[]> {
  const params: unknown[] = [];
  let sql = "SELECT * FROM mplus_logs WHERE 1=1";
  if (filters?.level)     { params.push(filters.level);     sql += ` AND level=$${params.length}`; }
  if (filters?.eventType) { params.push(filters.eventType); sql += ` AND event_type=$${params.length}`; }
  if (filters?.guildId)   { params.push(filters.guildId);   sql += ` AND guild_id=$${params.length}`; }
  if (filters?.channelId) { params.push(filters.channelId); sql += ` AND channel_id=$${params.length}`; }
  if (filters?.boostId)   { params.push(filters.boostId);   sql += ` AND boost_id=$${params.length}`; }
  if (filters?.search)    { params.push(`%${filters.search}%`); sql += ` AND message ILIKE $${params.length}`; }
  if (filters?.since)     { params.push(filters.since);     sql += ` AND created_at>=$${params.length}`; }
  if (filters?.until)     { params.push(filters.until);     sql += ` AND created_at<=$${params.length}`; }
  sql += " ORDER BY created_at DESC";
  params.push(filters?.limit??200, filters?.offset??0);
  sql += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
  return qAll<MplusLogRow>(env, sql, params);
}
export async function clearMplusLogs(env: Env): Promise<void> {
  await qRun(env, "DELETE FROM mplus_logs");
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export interface DashboardStats {
  totalGuilds: number; totalChannels: number; activeMonitoring: number;
  waitingBoosts: number; acceptedBoosts: number; ignoredBoosts: number; errorBoosts: number;
}
export async function getDashboardStats(env: Env): Promise<DashboardStats> {
  const [guilds, channels, waiting, accepted, ignored, errors, cfg] = await Promise.all([
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM guilds"),
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM channels WHERE active=1 AND monitoring=1"),
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM boosts WHERE status='WAITING'"),
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM boosts WHERE status='ACCEPTED'"),
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM boosts WHERE status='IGNORED'"),
    qOne<{n:string}>(env, "SELECT COUNT(*) AS n FROM boosts WHERE status='ERROR'"),
    getMonitoringConfig(env),
  ]);
  return {
    totalGuilds:     parseInt(guilds?.n  ?? "0"),
    totalChannels:   parseInt(channels?.n ?? "0"),
    activeMonitoring: cfg.enabled ? 1 : 0,
    waitingBoosts:   parseInt(waiting?.n  ?? "0"),
    acceptedBoosts:  parseInt(accepted?.n ?? "0"),
    ignoredBoosts:   parseInt(ignored?.n  ?? "0"),
    errorBoosts:     parseInt(errors?.n   ?? "0"),
  };
}

// ─── Resource failures ────────────────────────────────────────────────────────

export async function getResourceFailure(env: Env, key: string): Promise<import("./types.js").ResourceFailureRow | null> {
  return qOne(env, "SELECT * FROM resource_failures WHERE resource_key=$1", [key]);
}
export async function upsertResourceFailure(env: Env, row: import("./types.js").ResourceFailureRow): Promise<void> {
  await qRun(env,
    `INSERT INTO resource_failures(resource_key,failure_type,http_status,first_failed_at,last_failed_at,failure_count,cooldown_until,resolved_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(resource_key) DO UPDATE SET
       failure_type=EXCLUDED.failure_type, http_status=EXCLUDED.http_status,
       last_failed_at=EXCLUDED.last_failed_at, failure_count=EXCLUDED.failure_count,
       cooldown_until=EXCLUDED.cooldown_until, resolved_at=EXCLUDED.resolved_at`,
    [row.resource_key, row.failure_type, row.http_status, row.first_failed_at, row.last_failed_at, row.failure_count, row.cooldown_until, row.resolved_at]
  );
}
export async function resolveResourceFailure(env: Env, key: string): Promise<void> {
  await qRun(env, "UPDATE resource_failures SET resolved_at=$1 WHERE resource_key=$2", [nowMs(), key]);
}

// ─── Guild character types ────────────────────────────────────────────────────

export async function getGuildCharacterTypes(env: Env, guildId: string): Promise<import("./types.js").GuildCharacterTypesConfig> {
  try {
    const row = await qOne<GuildCharacterTypesRow>(env, "SELECT * FROM guild_character_types WHERE guild_id=$1", [guildId]);
    if (!row) return { guildId, allowAll: true, enabledTypes: [...CHARACTER_TYPES] };
    const types = row.enabled_types.split(",").map(s=>s.trim().toLowerCase()).filter((s): s is import("./types.js").CharacterType => (CHARACTER_TYPES as readonly string[]).includes(s));
    return { guildId, allowAll: row.allow_all===1, enabledTypes: types };
  } catch { return { guildId, allowAll: true, enabledTypes: [...CHARACTER_TYPES] }; }
}
export async function upsertGuildCharacterTypes(env: Env, guildId: string, enabledTypes: import("./types.js").CharacterType[], allowAll: boolean): Promise<void> {
  await qRun(env,
    `INSERT INTO guild_character_types(guild_id,enabled_types,allow_all,updated_at)
     VALUES($1,$2,$3,$4) ON CONFLICT(guild_id) DO UPDATE SET
       enabled_types=EXCLUDED.enabled_types, allow_all=EXCLUDED.allow_all, updated_at=EXCLUDED.updated_at`,
    [guildId, enabledTypes.join(","), allowAll?1:0, nowSec()]
  );
}
export async function isCharacterTypeAllowed(env: Env, guildId: string, characterType: string): Promise<boolean> {
  const config = await getGuildCharacterTypes(env, guildId);
  if (config.allowAll) return true;
  return config.enabledTypes.includes(characterType.toLowerCase() as import("./types.js").CharacterType);
}
