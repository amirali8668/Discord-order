/**
 * matching.ts – Matching engine for M+ boost channel detection (v2).
 *
 * evaluateChannelForSent replaces the old evaluateChannel.
 * KEY CHANGE: No WAITING lock check. Multiple channels can be sent simultaneously.
 * Only checks:
 *   1. monitoring enabled
 *   2. NOT paused_for_confirmation (accepted boost pending CONTINUE)
 *   3. channel active + monitored + parsed
 *   4. level in range
 *   5. fingerprint not already processed as SENT or ACCEPTED
 */

import type { Env, ChannelRow, MonitoringConfig } from "./types.js";
import { parseChannelName, isParsed } from "./parser.js";
import { levelInRange } from "./filter.js";
import {
  getBoostByFingerprint,
  upsertChannel,
  getMonitoredCategories,
  isCharacterTypeAllowed,
} from "./db.js";

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Build a deterministic fingerprint from channel fields.
 * Changes to count, level, or customer (channel rename) produce a new fingerprint.
 */
export function buildFingerprint(
  channelId: string,
  type: string,
  count: number,
  level: number,
  customer: string
): string {
  return `${channelId}:${type}:${count}:${level}:${customer}`;
}

// ─── Match result ─────────────────────────────────────────────────────────────

export type MatchResult =
  | { matched: true; fingerprint: string; type: string; count: number; level: number; customer: string }
  | { matched: false; reason: string };

// ─── Core matching function (v2 – no WAITING lock) ───────────────────────────

/**
 * Evaluate whether a channel should receive a boost message.
 * Multiple channels can pass this check in the same tick.
 */
export async function evaluateChannelForSent(
  env: Env,
  channel: ChannelRow,
  config: MonitoringConfig
): Promise<MatchResult> {
  // 1. Monitoring must be enabled
  if (!config.enabled) {
    return { matched: false, reason: "Monitoring is disabled" };
  }

  // 2. Paused for confirmation – waiting for admin CONTINUE after acceptance
  if (config.pausedForConfirmation) {
    return { matched: false, reason: "Paused for confirmation – waiting for admin CONTINUE" };
  }

  // 3. Channel must be active
  if (!channel.active) {
    return { matched: false, reason: "Channel is deleted/inactive" };
  }

  // 4. Channel must be monitored
  if (!channel.monitoring) {
    return { matched: false, reason: "Channel is not monitored" };
  }

  // 5. Channel name must parse
  const parseResult = parseChannelName(channel.name);
  if (!isParsed(parseResult)) {
    return { matched: false, reason: "Channel name does not match expected pattern" };
  }

  // 6. Level must be in range
  if (!levelInRange(parseResult.level, { minLevel: config.minLevel, maxLevel: config.maxLevel })) {
    return {
      matched: false,
      reason: `Level ${parseResult.level} outside range [${config.minLevel}–${config.maxLevel}]`,
    };
  }

  // 6b. Character type must be allowed for this guild (per-guild config)
  const charAllowed = await isCharacterTypeAllowed(env, channel.guild_id, parseResult.type);
  if (!charAllowed) {
    return {
      matched: false,
      reason: `Character type "${parseResult.type}" is not enabled for guild ${channel.guild_id}`,
    };
  }

  // 7. Fingerprint must not already be SENT or ACCEPTED (prevent duplicate messages)
  const fingerprint = buildFingerprint(
    channel.id, parseResult.type, parseResult.count, parseResult.level, parseResult.customer
  );
  const existing = await getBoostByFingerprint(env, fingerprint);
  if (existing) {
    const alreadyProcessed = ["SENT", "WAITING", "ACCEPTED"].includes(existing.status);
    if (alreadyProcessed) {
      return {
        matched: false,
        reason: `Fingerprint already processed (boost ${existing.id}, status: ${existing.status})`,
      };
    }
  }

  return {
    matched: true,
    fingerprint,
    type: parseResult.type,
    count: parseResult.count,
    level: parseResult.level,
    customer: parseResult.customer,
  };
}

// Keep old name as alias for backward compat with any remaining callers
export const evaluateChannel = evaluateChannelForSent;

// ─── Channel registration helper ─────────────────────────────────────────────

/**
 * Register or update a Discord channel in D1.
 * Parses the channel name, applies level filter, sets monitoring flags.
 * Idempotent – safe to call multiple times for the same channel.
 */
export async function registerChannel(
  env: Env,
  channelId: string,
  channelName: string,
  guildId: string,
  guildName: string,
  categoryId: string | null,
  categoryName: string | null,
  channelType: number,
  config: MonitoringConfig
): Promise<ChannelRow> {
  const parseResult = parseChannelName(channelName);
  const parsed = isParsed(parseResult);

  // Determine whether this channel's category is monitored
  let monitoring = 0;
  if (categoryId) {
    const monitoredCategories = await getMonitoredCategories(env);
    const categoryIsMonitored = monitoredCategories.some((c) => c.id === categoryId);
    if (categoryIsMonitored) monitoring = 1;
  }

  const inLevelRange =
    parsed && levelInRange(parseResult.level, { minLevel: config.minLevel, maxLevel: config.maxLevel })
      ? 1
      : 0;

  const row: Omit<ChannelRow, "created_at" | "updated_at"> = {
    id: channelId,
    guild_id: guildId,
    guild_name: guildName,
    category_id: categoryId,
    category_name: categoryName,
    name: channelName,
    channel_type: channelType,
    parsed: parsed ? 1 : 0,
    boost_type: parsed ? parseResult.type : null,
    boost_count: parsed ? parseResult.count : null,
    boost_level: parsed ? parseResult.level : null,
    customer: parsed ? parseResult.customer : null,
    parse_status: parsed ? "PARSED" : "UNPARSED",
    active: 1,
    monitoring,
    in_level_range: inLevelRange,
    last_event_at: null,
  };

  await upsertChannel(env, row);
  return { ...row, created_at: 0, updated_at: 0 }; // timestamps set by DB
}

// ─── Message template renderer ────────────────────────────────────────────────

/**
 * Render a message template with channel/boost context variables.
 *
 * Supported variables:
 *   {server}    {guild}     {category}  {channel}
 *   {channel_id} {customer} {level}     {count}
 *   {type}      {timestamp}
 */
export function renderTemplate(
  template: string,
  vars: {
    server: string;
    guild: string;
    category: string;
    channel: string;
    channel_id: string;
    customer: string;
    level: number;
    count: number;
    type: string;
    timestamp: string;
  }
): string {
  return template
    .replace(/\{server\}/g,     vars.server)
    .replace(/\{guild\}/g,      vars.guild)
    .replace(/\{category\}/g,   vars.category)
    .replace(/\{channel\}/g,    vars.channel)
    .replace(/\{channel_id\}/g, vars.channel_id)
    .replace(/\{customer\}/g,   vars.customer)
    .replace(/\{level\}/g,      String(vars.level))
    .replace(/\{count\}/g,      String(vars.count))
    .replace(/\{type\}/g,       vars.type)
    .replace(/\{timestamp\}/g,  vars.timestamp);
}
