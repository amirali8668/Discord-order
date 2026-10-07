/**
 * discord-notify.ts – Rich acceptance notification to Discord channel.
 *
 * Rules:
 *   - Sent ONLY after a real/valid acceptance.
 *   - Idempotency key: boost.notif_sent flag in D1.
 *   - Failure never reverts acceptance state.
 *   - Never exposes secrets.
 */

import type { Env } from "./types.js";
import { getBoost, getAcceptancesForBoost, markNotifSent, insertMplusLog } from "./db.js";
import { discordRequest, resolveToken } from "./discord-client.js";

// Idempotency key format: accepted_boost:{boost_id}
// notif_sent flag in D1 is the primary guard — this ensures even if
// D1 write fails, we don't send twice within the same Worker invocation.
const notifSentInvocation = new Set<string>();

async function sendChunk(
  env:       Pick<Env, "DISCORD_TOKEN" | "DISCORD_READ_TOKEN">,
  channelId: string,
  content:   string
): Promise<boolean> {
  const r = await discordRequest(resolveToken(env, "ACTION"), `/channels/${channelId}/messages`, {
    method: "POST",
    body: { content },
    priority: "HIGH",
    purpose: "acceptance notification",
    maxRetries: 2,
    skipCache: true,
  });
  return r.ok;
}

export async function sendDiscordAcceptanceNotification(
  env: Env,
  boostId: string,
  notificationChannelId: string
): Promise<void> {
  const boost = await getBoost(env, boostId);
  if (!boost) return;

  // Idempotency — invocation-level guard (D1 notif_sent is the persistent guard)
  const invocationKey = `accepted_boost:${boostId}`;
  if (notifSentInvocation.has(invocationKey)) {
    await insertMplusLog(env, "info", "SYSTEM",
      `Notification already sent this invocation for boost ${boostId} — skipping.`, { boostId });
    return;
  }

  // Idempotency – never send twice for the same boost (D1 guard)
  if (boost.notif_sent === 1) {
    await insertMplusLog(env, "info", "SYSTEM",
      `Notification already sent for boost ${boostId} – skipping duplicate.`, { boostId });
    return;
  }

  // Mark in-flight before sending to prevent race
  notifSentInvocation.add(invocationKey);

  const acceptances = await getAcceptancesForBoost(env, boostId);
  const acc = acceptances[acceptances.length - 1];

  const sentAt = boost.sent_at ? new Date(boost.sent_at).toISOString() : "—";
  const acceptedAt = boost.accepted_at ? new Date(boost.accepted_at).toISOString() : new Date().toISOString();

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `✅  **BOOST ACCEPTED**`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `**Boost ID:** \`${boost.id}\``,
    `**Status:** ACCEPTED`,
    ``,
    `**Server:** ${boost.guild_name}`,
    `**Guild ID:** \`${boost.guild_id}\``,
    `**Category:** ${boost.category_name ?? "—"}`,
    `**Category ID:** \`${boost.category_id ?? "—"}\``,
    `**TEXTLIMITED Channel:** #${boost.channel_name}`,
    `**Channel ID:** \`${boost.channel_id}\``,
    ``,
    `**Customer:** ${boost.customer}`,
    `**Dungeon Type:** ${boost.boost_type}`,
    `**Dungeon Level:** +${boost.level}`,
    `**Count:** ${boost.count}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📨  **BOOST MESSAGE**`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `**Message Content:**`,
    `> ${boost.outgoing_message_content ?? "—"}`,
    `**Outgoing Message ID:** \`${boost.outgoing_message_id ?? "—"}\``,
    `**Message Timestamp:** ${sentAt}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🎯  **ACCEPTANCE**`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `**Accepted By:** ${boost.accepted_by_username ?? "—"}`,
    `**Accepted User ID:** \`${boost.accepted_by_user_id ?? "—"}\``,
    `**Acceptance Method:** ${boost.acceptance_method ?? "—"}`,
    `**Reaction:** ${boost.accepted_reaction ?? "—"}`,
    `**Acceptance Message ID:** \`${acc?.mention_message_id ?? boost.acceptance_message_id ?? "—"}\``,
    `**Acceptance Channel ID:** \`${acc?.channel_id ?? boost.channel_id}\``,
    `**Acceptance Timestamp:** ${acceptedAt}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🔧  **SYSTEM STATE**`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `**Current State:** ACCEPTED`,
    `**Next State:** PAUSED_FOR_CONFIRMATION`,
    `⏸  System is paused. Admin must press **CONTINUE** to process the next boost.`,
  ];

  const content = lines.join("\n");

  // Discord message limit is 2000 characters – split if needed
  const MAX = 1950;
  const chunks: string[] = [];
  if (content.length <= MAX) {
    chunks.push(content);
  } else {
    // Split at section dividers
    const parts = content.split("━━━━━━━━━━━━━━━━━━━━");
    let current = "";
    for (const part of parts) {
      const seg = (current ? "━━━━━━━━━━━━━━━━━━━━" : "") + part;
      if ((current + seg).length > MAX) {
        if (current) chunks.push(current.trim());
        current = seg;
      } else {
        current += seg;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  let allSent = true;
  for (const chunk of chunks) {
    const sent = await sendChunk(env, notificationChannelId, chunk);
    if (!sent) { allSent = false; break; }
  }

  if (allSent) {
    await markNotifSent(env, boostId);
    await insertMplusLog(env, "success", "SYSTEM",
      `Acceptance notification sent to channel ${notificationChannelId} for boost ${boostId}.`,
      { boostId });
  } else {
    await insertMplusLog(env, "error", "API_ERROR",
      `Failed to send acceptance notification to channel ${notificationChannelId}. Boost remains ACCEPTED.`,
      { boostId });
  }
}

/** Test that a notification channel is reachable */
export async function testNotificationChannel(
  env: Env,
  channelId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await discordRequest(resolveToken(env, "ACTION"), `/channels/${channelId}/messages`, {
      method: "POST",
      body: { content: `━━━━━━━━━━━━━━━━━━━━\n🔔 **TEST NOTIFICATION**\n━━━━━━━━━━━━━━━━━━━━\n\nNotification channel is **CONNECTED** ✅\nTimestamp: ${new Date().toISOString()}` },
      priority: "HIGH",
      purpose: "test notification channel",
      maxRetries: 1,
      skipCache: true,
    });
    return r.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${r.status} — check channel ID and bot permissions` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
