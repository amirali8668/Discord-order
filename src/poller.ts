/**
 * poller.ts – Optimized REST polling for acceptance detection (v2).
 *
 * CHANGES v2:
 *  - ResourceCooldown is threaded through all discord-api calls.
 *    A channel that returns 403 or 404 is placed on cooldown and skipped
 *    in future ticks until the cooldown expires — preventing the
 *    "403 every minute forever" storm.
 *  - fetchOutgoingMessage / fetchMessageReactors / fetchChannelMessages
 *    all receive the cooldown instance and short-circuit if on cooldown.
 *  - The previous 1-request-per-emoji strategy is preserved.
 *
 * BEFORE (expensive): 20 requests per boost per tick (one per emoji)
 * AFTER  (efficient):  1 request per boost to check IF reactions exist,
 *                      then 1 request per emoji that ACTUALLY has reactions.
 *
 * Typical case (no reactions yet): 1 request per boost per tick.
 * Acceptance case (reaction exists): 2 requests total (check + get reactor).
 */

import type { Env, MonitoringConfig } from "./types.js";
import {
  getSentBoosts,
  insertMplusLog,
  getMonitoringConfig,
  updateBoostStatus,
} from "./db.js";
import { handleReactionAdd, handleMessageCreate } from "./acceptance.js";
import { rowToConfig } from "./monitor.js";
import {
  fetchOutgoingMessage,
  fetchMessageReactors,
  fetchChannelMessages,
} from "./discord-api.js";
import type { ResourceCooldown } from "./resource-cooldown.js";

export async function pollSentBoostsForAcceptance(
  env:      Env,
  config:   MonitoringConfig,
  cooldown: ResourceCooldown
): Promise<void> {
  if (!config.enabled) return;
  if (config.pausedForConfirmation) return;

  const sentBoosts = await getSentBoosts(env);
  if (sentBoosts.length === 0) return;

  await insertMplusLog(env, "info", "SYSTEM",
    `Polling ${sentBoosts.length} SENT boost(s)...`);

  for (const boost of sentBoosts) {
    if (!boost.outgoing_message_id) {
      await updateBoostStatus(env, boost.id, "ERROR");
      continue;
    }

    try {
      // ── 1. Reaction check — smart 2-step approach ──────────────────────
      if (config.acceptReaction) {
        // Step 1: ONE request to check if any reactions exist on our message.
        // If the channel is on cooldown (403/404 from a prev tick), returns null immediately.
        const msg = await fetchOutgoingMessage(
          env,
          boost.channel_id,
          boost.outgoing_message_id,
          cooldown
        );

        if (!msg) {
          // null means either:
          // a) Channel/message returned 403 → cooldown recorded by fetchOutgoingMessage
          // b) Channel/message returned 404 → also cooldown recorded
          // c) Channel was already on cooldown → skipped silently
          // In cases a/b, expire the boost so we don't keep polling it.
          const onCooldown = await cooldown.isOnCooldown(`channel:${boost.channel_id}`);
          if (onCooldown) {
            await insertMplusLog(env, "warn", "SYSTEM",
              `Channel ${boost.channel_id} on cooldown — expiring boost ${boost.id}`,
              { boostId: boost.id, channelId: boost.channel_id });
            await updateBoostStatus(env, boost.id, "EXPIRED");
          } else {
            // Message genuinely not found (404) but channel still accessible
            await insertMplusLog(env, "warn", "SYSTEM",
              `Cannot find message ${boost.outgoing_message_id} — marking boost EXPIRED`,
              { boostId: boost.id });
            await updateBoostStatus(env, boost.id, "EXPIRED");
          }
          continue;
        }

        if (!msg.reactions || msg.reactions.length === 0) {
          await insertMplusLog(env, "info", "SYSTEM",
            `No reactions on message ${boost.outgoing_message_id} yet`,
            { boostId: boost.id });
        } else {
          await insertMplusLog(env, "info", "SYSTEM",
            `Reactions found: ${msg.reactions.map((r) => `${r.emoji.name}(${r.count})`).join(", ")}`,
            { boostId: boost.id });

          for (const reaction of msg.reactions) {
            if (reaction.count === 0) continue;

            const emojiName = reaction.emoji.name;
            if (!emojiName) continue;

            const shouldAccept = config.anyReactionAccepted
              || config.acceptedReactions.includes(emojiName);
            if (!shouldAccept) continue;

            // Step 2: Get who reacted (only for acceptable emojis)
            const reactors = await fetchMessageReactors(
              env,
              boost.channel_id,
              boost.outgoing_message_id,
              emojiName,
              100,
              cooldown
            );

            if (reactors.length === 0) continue;

            const reactor = reactors[0];
            await insertMplusLog(env, "success", "ACCEPTANCE_DETECTED",
              `✅ Reaction ${emojiName} by ${reactor.username} (${reactor.id})`,
              { boostId: boost.id, channelId: boost.channel_id, guildId: boost.guild_id });

            await handleReactionAdd(env, {
              user_id:    reactor.id,
              channel_id: boost.channel_id,
              message_id: boost.outgoing_message_id,
              guild_id:   boost.guild_id ?? undefined,
              emoji:      { id: reaction.emoji.id ?? null, name: emojiName },
              member:     { user: { id: reactor.id, username: reactor.username } },
            }, config);

            // Re-read config from D1 after acceptance
            const freshConfig = rowToConfig(await getMonitoringConfig(env));
            if (freshConfig.pausedForConfirmation) {
              await insertMplusLog(env, "success", "SYSTEM",
                "Boost ACCEPTED via reaction — stopping poll.");
              return;
            }

            break; // one reaction is enough in ANY mode
          }
        }
      }

      // Re-check paused state before mention check
      const currentConfig = rowToConfig(await getMonitoringConfig(env));
      if (currentConfig.pausedForConfirmation) return;

      // ── 2. Mention check ───────────────────────────────────────────────
      if (config.acceptMention && config.mentionTargetId) {
        const messages = await fetchChannelMessages(
          env,
          boost.channel_id,
          20,
          cooldown
        );

        for (const msg of messages) {
          const msgTimeMs = new Date(msg.timestamp).getTime();
          if (msgTimeMs < boost.created_at) continue;

          const inArray   = (msg.mentions ?? []).some((m) => m.id === config.mentionTargetId);
          const inContent =
            msg.content.includes(`<@${config.mentionTargetId}>`) ||
            msg.content.includes(`<@!${config.mentionTargetId}>`);

          if (!inArray && !inContent) continue;

          await insertMplusLog(env, "success", "ACCEPTANCE_DETECTED",
            `✅ Mention by ${msg.author.username} (inArray=${inArray}, inContent=${inContent})`,
            { boostId: boost.id, channelId: boost.channel_id });

          const mentions = inArray
            ? (msg.mentions ?? [])
            : [...(msg.mentions ?? []), { id: config.mentionTargetId, username: "target" }];

          await handleMessageCreate(env, {
            id:         msg.id,
            channel_id: boost.channel_id,
            guild_id:   boost.guild_id ?? undefined,
            author:     msg.author,
            content:    msg.content,
            mentions,
            timestamp:  msg.timestamp,
          }, config);

          const freshConfig = rowToConfig(await getMonitoringConfig(env));
          if (freshConfig.pausedForConfirmation) {
            await insertMplusLog(env, "success", "SYSTEM",
              "Boost ACCEPTED via mention — stopping poll.");
            return;
          }
        }
      } else if (config.acceptMention && !config.mentionTargetId) {
        await insertMplusLog(env, "warn", "SYSTEM",
          "Mention acceptance ON but mentionTargetId not configured — set it in Filters page.",
          { boostId: boost.id });
      }

    } catch (err) {
      await insertMplusLog(env, "error", "API_ERROR",
        `Poll error for boost ${boost.id}: ${String(err)}`,
        { boostId: boost.id, channelId: boost.channel_id });
    }
  }
}
