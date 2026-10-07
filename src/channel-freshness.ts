/**
 * channel-freshness.ts – Determines whether a channel is "new enough" to
 * receive a boost message, based on the first and last message timestamps.
 *
 * CREDENTIAL: READ (DISCORD_READ_TOKEN)
 *   Message history is read-only information used to determine channel age.
 *   Uses DISCORD_READ_TOKEN via resolveToken(env, "READ").
 *
 * RULE (4-minute threshold):
 *  Case A — both first AND last exist:
 *    diff = last - first
 *    if diff > 240 s  →  OLD  →  DO NOT SEND
 *    if diff ≤ 240 s  →  NEW  →  ALLOW SEND
 *
 *  Case B — first exists but last does NOT (only one message):
 *    Treat as a brand-new channel → ALLOW SEND
 *
 *  Case C — no messages at all:
 *    Conservative default → DO NOT SEND
 *
 * IMPLEMENTATION:
 *  2 requests: newest (limit=1) + oldest (limit=1&after=0)
 *  Both go through the centralized rate-limit manager.
 *  skipCache=true — always read live timestamps.
 */

import type { Env } from "./types.js";
import { discordRequest, resolveToken } from "./discord-client.js";
import type { ResourceCooldown } from "./resource-cooldown.js";
import { channelKey } from "./resource-cooldown.js";

// ─── Public constant ──────────────────────────────────────────────────────────

/** Maximum allowed age of a channel (first→last message diff) in milliseconds. */
export const CHANNEL_MAX_AGE_MS = 4 * 60 * 1000; // 4 min = 240 000 ms

// ─── Types ────────────────────────────────────────────────────────────────────

export type FreshnessDecision =
  | { fresh: true }
  | { fresh: false; reason: string; firstMs?: number; lastMs?: number; diffMs?: number };

interface DiscordMessageStub { id: string; timestamp: string; }

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Check whether a channel is fresh enough to receive a boost message.
 * Uses READ credential (DISCORD_READ_TOKEN) for all requests.
 * Throws clearly if DISCORD_READ_TOKEN is not configured.
 */
export async function isChannelFresh(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  cooldown?: ResourceCooldown
): Promise<FreshnessDecision> {

  // ── Cooldown gate ─────────────────────────────────────────────────────────
  if (cooldown) {
    const rk = channelKey(channelId);
    if (await cooldown.isOnCooldown(rk)) {
      return { fresh: false, reason: `Channel ${channelId} is on cooldown — skipping freshness check` };
    }
  }

  // Resolve READ token — throws with a clear message if not configured
  const readToken = resolveToken(env, "READ");

  // ── Step 1: Fetch newest message ──────────────────────────────────────────
  const newestResp = await discordRequest<DiscordMessageStub[]>(
    readToken,
    `/channels/${channelId}/messages?limit=1`,
    { priority: "MEDIUM", purpose: `freshness newest msg ch=${channelId}`, skipCache: true, maxRetries: 1 }
  );

  if (!newestResp.ok || !Array.isArray(newestResp.data) || newestResp.data.length === 0) {
    if (newestResp.permanent && cooldown) {
      await cooldown.recordFailure(
        channelKey(channelId),
        newestResp.status === 403 ? "FORBIDDEN" : "NOT_FOUND",
        newestResp.status
      );
    }
    return {
      fresh:  false,
      reason: newestResp.ok
        ? "Channel has no messages — conservative: skip"
        : `Discord API error ${newestResp.status} — skip`,
    };
  }

  const newestMsg = newestResp.data[0];
  const lastMs    = parseDiscordTimestamp(newestMsg.timestamp);

  // ── Step 2: Fetch oldest message ──────────────────────────────────────────
  const oldestResp = await discordRequest<DiscordMessageStub[]>(
    readToken,
    `/channels/${channelId}/messages?limit=1&after=0`,
    { priority: "MEDIUM", purpose: `freshness oldest msg ch=${channelId}`, skipCache: true, maxRetries: 1 }
  );

  if (!oldestResp.ok || !Array.isArray(oldestResp.data) || oldestResp.data.length === 0) {
    return { fresh: true }; // Case B: single-message channel → new
  }

  const oldestMsg = oldestResp.data[0];
  const firstMs   = parseDiscordTimestamp(oldestMsg.timestamp);

  // Case B: same message ID → only one message in channel → new
  if (oldestMsg.id === newestMsg.id) return { fresh: true };

  // Case A: compute diff
  const diffMs = lastMs - firstMs;
  if (diffMs > CHANNEL_MAX_AGE_MS) {
    return {
      fresh:  false,
      reason: `Channel is OLD: diff=${Math.round(diffMs / 1000)}s > ${CHANNEL_MAX_AGE_MS / 1000}s`,
      firstMs, lastMs, diffMs,
    };
  }
  return { fresh: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function parseDiscordTimestamp(ts: string): number {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`Invalid Discord timestamp: ${ts}`);
  return ms;
}
