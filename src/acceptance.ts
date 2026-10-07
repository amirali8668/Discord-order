/**
 * acceptance.ts – Acceptance detection (v2 – multi-boost concurrent).
 *
 * Key change from v1:
 *   - Multiple boosts can be in SENT state simultaneously.
 *   - Each acceptance is correlated to the EXACT outgoing message ID.
 *   - A reaction on message 222 only accepts the boost that sent message 222.
 *   - Acceptance of ANY boost → PAUSED_FOR_CONFIRMATION.
 *   - Sending a message does NOT trigger pause.
 */

import type {
  Env,
  DiscordReactionEvent,
  DiscordMessageEvent,
  MonitoringConfig,
  AcceptanceMethod,
} from "./types.js";
import {
  newId,
  getBoostByOutgoingMessageId,
  getSentBoostForChannel,
  createAcceptance,
  acceptanceExistsForBoost,
  updateBoostAccepted,
  insertMplusLog,
  getMonitoringConfig,
} from "./db.js";
import { transitionToAccepted } from "./boost-machine.js";
import { sendDiscordAcceptanceNotification } from "./discord-notify.js";
import { rowToConfig } from "./monitor.js";

// ─── Reaction acceptance ──────────────────────────────────────────────────────

export async function handleReactionAdd(
  env: Env,
  event: DiscordReactionEvent,
  config: MonitoringConfig
): Promise<void> {
  if (!config.acceptReaction) return;
  if (!config.enabled) return;
  if (config.pausedForConfirmation) return; // already accepted, waiting for CONTINUE

  // Find the exact boost by outgoing message ID
  const boost = await getBoostByOutgoingMessageId(env, event.message_id);
  if (!boost) return;
  if (boost.status !== "SENT" && boost.status !== "WAITING") return;

  // Must be in the exact channel where the boost message was sent
  if (boost.channel_id !== event.channel_id) {
    await insertMplusLog(env, "warn", "ACCEPTANCE_DUPLICATE",
      `Reaction on msg ${event.message_id} in wrong channel ${event.channel_id}`,
      { boostId: boost.id });
    return;
  }

  // Emoji filter (if any_reaction_accepted=false, check specific emojis)
  if (!config.anyReactionAccepted) {
    if (!config.acceptedReactions.includes(event.emoji.name)) return;
  }

  // Idempotency – never accept the same boost twice
  if (await acceptanceExistsForBoost(env, boost.id)) {
    await insertMplusLog(env, "info", "ACCEPTANCE_DUPLICATE",
      `Duplicate acceptance ignored for boost ${boost.id}`, { boostId: boost.id });
    return;
  }

  const username = event.member?.user?.username ?? null;

  await createAcceptance(env, {
    id: newId(),
    boost_id: boost.id,
    outgoing_message_id: event.message_id,
    channel_id: event.channel_id,
    method: "REACTION",
    accepted_by_user_id: event.user_id,
    accepted_by_username: username,
    reaction_emoji: event.emoji.name,
    mention_message_id: null,
    mention_content: null,
    accepted_at: Date.now(),
  });

  await insertMplusLog(env, "success", "ACCEPTANCE_DETECTED",
    `REACTION ${event.emoji.name} by ${event.user_id} → boost ${boost.id} ACCEPTED`, {
      boostId: boost.id, channelId: boost.channel_id, guildId: boost.guild_id,
    });

  await completeAcceptance(env, boost.id, "REACTION",
    event.user_id, username, event.emoji.name, event.message_id);
}

// ─── Mention acceptance ───────────────────────────────────────────────────────

export async function handleMessageCreate(
  env: Env,
  event: DiscordMessageEvent,
  config: MonitoringConfig
): Promise<void> {
  if (!config.acceptMention) return;
  if (!config.mentionTargetId) return;
  if (!config.enabled) return;
  if (config.pausedForConfirmation) return;

  // Must mention the target user — check both mentions array and content
  const mentions = event.mentions ?? [];
  const inMentionsArray = mentions.some((m) => m.id === config.mentionTargetId);
  const inContent =
    event.content.includes(`<@${config.mentionTargetId}>`) ||
    event.content.includes(`<@!${config.mentionTargetId}>`);

  if (!inMentionsArray && !inContent) return;

  // Find a SENT boost in this exact channel
  const boost = await getSentBoostForChannel(env, event.channel_id);
  if (!boost) return;

  // Message must be after (or same time as) boost creation — 5s tolerance
  const msgTime = new Date(event.timestamp).getTime();
  if (msgTime < boost.created_at - 5000) return;

  // Idempotency
  if (await acceptanceExistsForBoost(env, boost.id)) {
    await insertMplusLog(env, "info", "ACCEPTANCE_DUPLICATE",
      `Duplicate MENTION acceptance ignored for boost ${boost.id}`, { boostId: boost.id });
    return;
  }

  await createAcceptance(env, {
    id: newId(),
    boost_id: boost.id,
    outgoing_message_id: boost.outgoing_message_id ?? "",
    channel_id: event.channel_id,
    method: "MENTION",
    accepted_by_user_id: event.author.id,
    accepted_by_username: event.author.username,
    reaction_emoji: null,
    mention_message_id: event.id,
    mention_content: event.content,
    accepted_at: Date.now(),
  });

  await insertMplusLog(env, "success", "ACCEPTANCE_DETECTED",
    `MENTION by ${event.author.id} → boost ${boost.id} ACCEPTED`, {
      boostId: boost.id, channelId: boost.channel_id, guildId: boost.guild_id,
    });

  await completeAcceptance(env, boost.id, "MENTION",
    event.author.id, event.author.username, null, event.id);
}

// ─── Complete acceptance ──────────────────────────────────────────────────────

async function completeAcceptance(
  env: Env,
  boostId: string,
  method: AcceptanceMethod,
  userId: string,
  username: string | null,
  reaction: string | null,
  messageId: string | null
): Promise<void> {
  // 1. Update boost to ACCEPTED in D1
  await updateBoostAccepted(env, boostId, method, userId, username, reaction, messageId);

  // 2. Transition system to PAUSED_FOR_CONFIRMATION (stop processing new boosts)
  await transitionToAccepted(env, boostId);

  // 3. Send rich notification to Discord notification channel
  //    Failure MUST NOT revert acceptance state
  try {
    const cfgRow = await getMonitoringConfig(env);
    const config = rowToConfig(cfgRow);
    if (config.notificationChannelId) {
      await sendDiscordAcceptanceNotification(env, boostId, config.notificationChannelId);
    }
  } catch (err) {
    await insertMplusLog(env, "error", "API_ERROR",
      `Discord notification failed for boost ${boostId}: ${String(err)}. Acceptance remains ACCEPTED.`,
      { boostId });
    // Do NOT rethrow – acceptance stays ACCEPTED regardless
  }
}
