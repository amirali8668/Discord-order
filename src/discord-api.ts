/**
 * discord-api.ts – Extended Discord REST helpers (M+ monitoring) v3.
 *
 * CREDENTIAL ROUTING (v3):
 *   All functions now accept `env` instead of a raw `token` string.
 *   The correct credential is selected automatically based on operation type:
 *
 *     READ   (channel discovery, metadata, message history)
 *            → DISCORD_READ_TOKEN
 *
 *     ACTION (send message, write ops, reactions for acceptance)
 *            → DISCORD_TOKEN  (main credential)
 *
 *   Selection is done via resolveToken(env, purpose) in discord-client.ts.
 *   There is NO automatic fallback from READ to ACTION if the read token fails.
 *   If DISCORD_READ_TOKEN is not configured, read operations throw clearly.
 *
 * All requests still go through the centralized rate-limit manager in
 * discord-client.ts (rate limits, retry, caching, dedup, cooldowns).
 */

import type { DiscordGuild, DiscordChannel, Env, CredentialPurpose } from "./types.js";
import type { ResourceCooldown } from "./resource-cooldown.js";
import {
  discordRequest,
  resolveToken,
  invalidateChannelCache,
  invalidateGuildCache,
} from "./discord-client.js";
import { channelKey, guildKey } from "./resource-cooldown.js";

// ─── Internal helper ──────────────────────────────────────────────────────────

/** Resolve the correct token and log a clear error if missing. */
function token(env: Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">, purpose: CredentialPurpose): string {
  return resolveToken(env, purpose);
}

// ─── Guild resolution (READ) ──────────────────────────────────────────────────

/**
 * Fetch guild metadata.
 * Purpose: READ — uses DISCORD_READ_TOKEN.
 */
export async function fetchGuild(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  guildId:   string,
  priority:  "HIGH" | "MEDIUM" | "LOW" = "MEDIUM",
  cooldown?: ResourceCooldown
): Promise<DiscordGuild | null> {
  const rk = guildKey(guildId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] fetchGuild ${guildId} skipped — ${cooldown.cooldownReason(rk)}`);
    return null;
  }
  const r = await discordRequest<DiscordGuild>(token(env, "READ"), `/guilds/${guildId}`, {
    priority, purpose: `fetch guild ${guildId}`,
  });
  if (r.ok && r.data) { cooldown?.recordSuccess(rk); return r.data; }
  if (r.permanent && cooldown) {
    await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
  }
  return null;
}

// ─── Channel resolution (READ) ────────────────────────────────────────────────

/**
 * Fetch a single channel's metadata.
 * Purpose: READ — uses DISCORD_READ_TOKEN.
 */
export async function fetchChannel(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  priority:  "HIGH" | "MEDIUM" | "LOW" = "MEDIUM",
  cooldown?: ResourceCooldown
): Promise<DiscordChannel | null> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] fetchChannel ${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return null;
  }
  const r = await discordRequest<DiscordChannel>(token(env, "READ"), `/channels/${channelId}`, {
    priority, purpose: `fetch channel ${channelId}`,
  });
  if (r.ok && r.data) { cooldown?.recordSuccess(rk); return r.data; }
  if (r.permanent && cooldown) {
    await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
  }
  return null;
}

/**
 * Fetch all channels for a guild.
 * Purpose: READ — uses DISCORD_READ_TOKEN.
 * Pass skipCache=true in reconciliation to always get fresh data.
 */
export async function fetchGuildChannels(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  guildId:   string,
  priority:  "HIGH" | "MEDIUM" | "LOW" = "LOW",
  cooldown?: ResourceCooldown,
  skipCache  = false
): Promise<DiscordChannel[]> {
  const rk = guildKey(guildId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] fetchGuildChannels ${guildId} skipped — ${cooldown.cooldownReason(rk)}`);
    return [];
  }
  const r = await discordRequest<DiscordChannel[]>(
    token(env, "READ"),
    `/guilds/${guildId}/channels`,
    { priority, purpose: `fetch guild channels ${guildId}`, skipCache }
  );
  if (r.ok && r.data) { cooldown?.recordSuccess(rk); return r.data; }
  if (r.permanent && cooldown) {
    await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
  }
  return [];
}

/**
 * Fetch text channels under a specific category.
 * Purpose: READ — reuses pre-fetched guild channel list where possible.
 */
export async function fetchCategoryChildren(
  env:          Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  categoryId:   string,
  guildId:      string,
  cooldown?:    ResourceCooldown,
  allChannels?: DiscordChannel[]
): Promise<DiscordChannel[]> {
  const channels = allChannels ?? await fetchGuildChannels(env, guildId, "LOW", cooldown);
  return channels.filter((ch) => ch.type === 0 && ch.parent_id === categoryId);
}

// ─── Resolve arbitrary Discord ID (READ) ─────────────────────────────────────

export interface ResolvedResource {
  type:         "guild" | "category" | "channel";
  guildId:      string;
  guildName:    string;
  resourceId:   string;
  resourceName: string;
  parentId?:    string | null;
}

/**
 * Resolve a Discord snowflake ID to guild/category/channel info.
 * Purpose: READ — uses DISCORD_READ_TOKEN.
 */
export async function resolveDiscordId(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  id:        string,
  cooldown?: ResourceCooldown
): Promise<ResolvedResource | null> {
  const channel = await fetchChannel(env, id, "MEDIUM", cooldown);
  if (channel) {
    const guildId = channel.guild_id;
    if (!guildId) return null;
    const guild = await fetchGuild(env, guildId, "MEDIUM", cooldown);
    if (!guild) return null;
    return {
      type:         channel.type === 4 ? "category" : "channel",
      guildId:      guild.id,
      guildName:    guild.name,
      resourceId:   channel.id,
      resourceName: channel.name ?? id,
      parentId:     channel.parent_id,
    };
  }
  const guild = await fetchGuild(env, id, "MEDIUM", cooldown);
  if (guild) {
    return {
      type: "guild", guildId: guild.id, guildName: guild.name,
      resourceId: guild.id, resourceName: guild.name,
    };
  }
  return null;
}

// ─── Message sending (ACTION) ────────────────────────────────────────────────

export interface SentMessage {
  id:         string;
  channel_id: string;
  content:    string;
}

export interface SendResult {
  message:   SentMessage | null;
  permanent: boolean;
  status:    number;
}

/**
 * Send a message to a Discord channel.
 * Purpose: ACTION — uses DISCORD_TOKEN (main credential).
 * maxRetries=1 to prevent duplicate messages on ambiguous timeout.
 */
export async function sendChannelMessage(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  content:   string,
  cooldown?: ResourceCooldown
): Promise<SendResult> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] sendChannelMessage ${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return { message: null, permanent: true, status: 0 };
  }
  const r = await discordRequest<SentMessage>(
    token(env, "ACTION"),
    `/channels/${channelId}/messages`,
    {
      method:     "POST",
      body:       { content },
      priority:   "HIGH",
      purpose:    `send boost message to channel ${channelId}`,
      maxRetries: 1,
      skipCache:  true,
    }
  );
  if (r.ok && r.data) { cooldown?.recordSuccess(rk); return { message: r.data, permanent: false, status: r.status }; }
  if (r.permanent && cooldown) {
    const ft = r.status === 403 ? "FORBIDDEN" : r.status === 404 ? "NOT_FOUND" : "SEND_FAILED";
    await cooldown.recordFailure(rk, ft, r.status);
  }
  return { message: null, permanent: r.permanent, status: r.status };
}

// ─── Reaction/acceptance polling (ACTION) ────────────────────────────────────
//
// Reaction checks use the MAIN credential because:
// 1. Checking reactions on OUR outgoing message verifies the acceptance state
//    for the boost the MAIN account sent — this is part of the action/state flow.
// 2. The main account has clear access to messages it sent.
// 3. This prevents any credential mismatch between who sent and who reads the message.

export interface DiscordUser {
  id:             string;
  username:       string;
  discriminator?: string;
  bot?:           boolean;
}

export interface MessageReaction {
  emoji: { id?: string | null; name: string };
  count: number;
}

export interface MessageWithReactions {
  id:         string;
  reactions?: MessageReaction[];
}

/**
 * Fetch our outgoing message to check if it has reactions.
 * Purpose: ACTION — uses DISCORD_TOKEN (main credential).
 * We read our own outgoing message using the account that sent it.
 */
export async function fetchOutgoingMessage(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  messageId: string,
  cooldown?: ResourceCooldown
): Promise<MessageWithReactions | null> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] fetchOutgoingMessage ch=${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return null;
  }
  const r = await discordRequest<MessageWithReactions[]>(
    token(env, "ACTION"),
    `/channels/${channelId}/messages?around=${messageId}&limit=3`,
    { priority: "MEDIUM", purpose: `check reactions on msg=${messageId}`, skipCache: true }
  );
  if (!r.ok) {
    if (r.permanent && cooldown) {
      await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
    }
    return null;
  }
  if (!Array.isArray(r.data)) return null;
  cooldown?.recordSuccess(rk);
  return r.data.find((m) => m.id === messageId) ?? null;
}

/**
 * Fetch users who reacted with a specific emoji.
 * Purpose: ACTION — uses DISCORD_TOKEN (main credential).
 * Part of the acceptance detection flow for the main account's messages.
 */
export async function fetchMessageReactors(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  messageId: string,
  emoji:     string,
  limit      = 100,
  cooldown?: ResourceCooldown
): Promise<DiscordUser[]> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) return [];
  const encoded = encodeURIComponent(emoji);
  const r = await discordRequest<DiscordUser[]>(
    token(env, "ACTION"),
    `/channels/${channelId}/messages/${messageId}/reactions/${encoded}?limit=${limit}&type=0`,
    { priority: "MEDIUM", purpose: `fetch reactors emoji=${emoji} msg=${messageId}`, skipCache: true }
  );
  if (!r.ok) {
    if (r.permanent && cooldown) {
      await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
    }
    return [];
  }
  cooldown?.recordSuccess(rk);
  if (!Array.isArray(r.data)) return [];
  return r.data.filter((u) => !u.bot);
}

/**
 * Fetch recent messages from a channel for mention detection.
 * Purpose: ACTION — uses DISCORD_TOKEN (main credential).
 * Mention acceptance is part of the action/state flow for the main account.
 */
export async function fetchChannelMessages(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  limit      = 20,
  cooldown?: ResourceCooldown
): Promise<Array<{
  id:        string;
  content:   string;
  author:    { id: string; username: string };
  mentions?: Array<{ id: string; username: string }>;
  timestamp: string;
}>> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord-api] fetchChannelMessages ch=${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return [];
  }
  const r = await discordRequest(
    token(env, "ACTION"),
    `/channels/${channelId}/messages?limit=${limit}`,
    { priority: "MEDIUM", purpose: `fetch messages ch=${channelId}`, skipCache: true }
  );
  if (!r.ok) {
    if (r.permanent && cooldown) {
      await cooldown.recordFailure(rk, r.status === 403 ? "FORBIDDEN" : "NOT_FOUND", r.status);
    }
    return [];
  }
  cooldown?.recordSuccess(rk);
  if (!Array.isArray(r.data)) return [];
  return r.data as ReturnType<typeof fetchChannelMessages> extends Promise<infer T> ? T : never;
}

// ─── Cache invalidation ───────────────────────────────────────────────────────

export function onChannelUpdated(channelId: string): void {
  invalidateChannelCache(channelId);
}

export function onGuildUpdated(guildId: string): void {
  invalidateGuildCache(guildId);
}
