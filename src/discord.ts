/**
 * discord.ts – Original bot Discord helpers (v3).
 *
 * CREDENTIAL ROUTING:
 *   getChannelMessages  → READ  (DISCORD_READ_TOKEN)
 *   openDmChannel       → ACTION (DISCORD_TOKEN) — opening a DM is a write action
 *   sendMessage         → ACTION (DISCORD_TOKEN)
 *   sendDm              → ACTION (opens DM + sends)
 *   getDmMessages       → READ  (reading DM messages)
 *
 * All requests still route through discord-client.ts (rate limits, retries,
 * cooldowns, caching).
 */

import type { DiscordMessage, DiscordChannel, Env } from "./types.js";
import { discordRequest, resolveToken }              from "./discord-client.js";
import type { ResourceCooldown }                     from "./resource-cooldown.js";
import { channelKey, dmKey }                         from "./resource-cooldown.js";

/** Fetch recent messages from a channel. Purpose: READ */
export async function getChannelMessages(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  limit      = 5,
  cooldown?: ResourceCooldown
): Promise<DiscordMessage[]> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord] getChannelMessages ch=${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return [];
  }
  const r = await discordRequest<DiscordMessage[]>(
    resolveToken(env, "READ"),
    `/channels/${channelId}/messages?limit=${limit}`,
    { priority: "MEDIUM", purpose: "original-bot: fetch channel messages", skipCache: true }
  );
  if (!r.ok) {
    if (r.permanent && cooldown) {
      const ft = r.status === 403 ? "FORBIDDEN" : r.status === 404 ? "NOT_FOUND" : "BAD_REQUEST";
      await cooldown.recordFailure(rk, ft, r.status);
    }
    return [];
  }
  cooldown?.recordSuccess(rk);
  return r.data ?? [];
}

/** Open (or retrieve existing) DM channel with a user. Purpose: ACTION */
export async function openDmChannel(
  env:      Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  userId:   string,
  cooldown?: ResourceCooldown
): Promise<string | null> {
  const rk = dmKey(userId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord] openDmChannel user=${userId} skipped — ${cooldown.cooldownReason(rk)}`);
    return null;
  }
  const r = await discordRequest<DiscordChannel>(
    resolveToken(env, "ACTION"),
    "/users/@me/channels",
    { method: "POST", body: { recipient_id: userId }, priority: "MEDIUM", purpose: `open DM with ${userId}` }
  );
  if (!r.ok) {
    if (r.permanent && cooldown) {
      const ft = r.status === 403 ? "FORBIDDEN" : "BAD_REQUEST";
      await cooldown.recordFailure(rk, ft, r.status);
    }
    return null;
  }
  cooldown?.recordSuccess(rk);
  return r.data?.id ?? null;
}

/** Send a message to a channel. Purpose: ACTION */
export async function sendMessage(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  content:   string,
  cooldown?: ResourceCooldown
): Promise<boolean> {
  const rk = channelKey(channelId);
  if (cooldown && await cooldown.isOnCooldown(rk)) {
    console.log(`[discord] sendMessage ch=${channelId} skipped — ${cooldown.cooldownReason(rk)}`);
    return false;
  }
  const r = await discordRequest(
    resolveToken(env, "ACTION"),
    `/channels/${channelId}/messages`,
    { method: "POST", body: { content }, priority: "HIGH", purpose: "original-bot: send message", maxRetries: 1, skipCache: true }
  );
  if (!r.ok && r.permanent && cooldown) {
    const ft = r.status === 403 ? "FORBIDDEN" : r.status === 404 ? "NOT_FOUND" : "SEND_FAILED";
    await cooldown.recordFailure(rk, ft, r.status);
  }
  if (r.ok) cooldown?.recordSuccess(rk);
  return r.ok && r.data !== null;
}

/** Send a DM to a user. Purpose: ACTION */
export async function sendDm(
  env:      Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  userId:   string,
  content:  string,
  cooldown?: ResourceCooldown
): Promise<boolean> {
  const channelId = await openDmChannel(env, userId, cooldown);
  if (!channelId) return false;
  return sendMessage(env, channelId, content, cooldown);
}

/** Fetch recent messages from a DM channel. Purpose: READ */
export async function getDmMessages(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  limit      = 5,
  cooldown?: ResourceCooldown
): Promise<DiscordMessage[]> {
  return getChannelMessages(env, channelId, limit, cooldown);
}
