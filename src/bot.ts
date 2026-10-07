/**
 * bot.ts – Original bot logic v2.
 *
 * CHANGES v2:
 *  - ResourceCooldown is instantiated once per tick and threaded through
 *    all Discord helpers (getChannelMessages, openDmChannel, sendMessage, sendDm).
 *    A channel/DM that returns 403 or 404 is placed on cooldown so it is NOT
 *    retried on every subsequent cron tick.
 *
 * Flow per cron tick (unchanged):
 *  1. Load all state from KV
 *  2. Poll each channel for new messages
 *  3. Classify messages → main / inventory / ignored
 *  4. Handle approval flow via target DMs
 *  5. Handle target commands (ok / down / reset)
 *  6. Resend "order is ready" ping every ping_interval_seconds
 *  7. Persist all mutated state back to KV
 */

import type { Env, DiscordMessage, PendingTarget } from "./types.js";
import { getChannelMessages, getDmMessages, openDmChannel, sendMessage, sendDm } from "./discord.js";
import {
  getConfig, getSeenMessages, saveSeenMessages, getPendingTargets, savePendingTargets,
  getInventorySent, saveInventorySent, getUsersReceivedMain, saveUsersReceivedMain,
  getMessageCount, saveMessageCount, getAutoApprove, saveAutoApprove,
  getAwaitingApproval, saveAwaitingApproval, getBotEnabled, addLog, setBotEnabled,
} from "./state.js";
import { ResourceCooldown } from "./resource-cooldown.js";

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runBotTick(env: Env): Promise<void> {
  const enabled = await getBotEnabled(env);
  if (!enabled) {
    console.log("[ℹ️] Bot is disabled. Skipping tick.");
    return;
  }

  const cooldown = new ResourceCooldown(env);

  const config = await getConfig(env);
  if (config.channels.length === 0) {
    await addLog(env, "warn", "No channels configured. Skipping tick.");
    return;
  }

  const [
    seen,
    pendingTargets,
    inventorySent,
    usersReceivedMain,
    messageCount,
    autoApprove,
    awaitingApproval,
  ] = await Promise.all([
    getSeenMessages(env),
    getPendingTargets(env),
    getInventorySent(env),
    getUsersReceivedMain(env),
    getMessageCount(env),
    getAutoApprove(env),
    getAwaitingApproval(env),
  ]);

  let mMessageCount    = messageCount;
  let mAutoApprove     = autoApprove;
  let mAwaitingApproval = awaitingApproval;

  // ── Poll channels ───────────────────────────────────────────────────────────
  for (const channelId of config.channels) {
    let messages: DiscordMessage[];
    try {
      // Pass env (not bare token) — READ credential used for channel messages
      messages = await getChannelMessages(env, channelId, config.poll_limit, cooldown);
    } catch (err) {
      await addLog(env, "error", `Failed to fetch channel ${channelId}: ${String(err)}`);
      continue;
    }

    for (const message of messages) {
      const msgId    = message.id;
      if (seen.has(msgId)) continue;
      seen.add(msgId);

      const authorId  = message.author.id;
      const content   = message.content;
      const reactions = message.reactions ?? [];

      const contentLower      = content.toLowerCase();
      const allKeywordsMatch  = config.keywords_all.every((k) =>
        contentLower.includes(k.toLowerCase())
      );
      const singleKeywordMatch = config.keyword_single.toLowerCase();
      const hasBannedKeyword  = config.banned_keywords.some((b) =>
        contentLower.includes(b.toLowerCase())
      );

      // ── Main message condition ─────────────────────────────────────────────
      if (allKeywordsMatch && reactions.length === 0) {
        if (hasBannedKeyword) {
          await addLog(env, "warn", `Skipped message ${msgId} – contains banned keyword.`);
          continue;
        }

        mMessageCount++;
        let shouldSend = false;

        if (mMessageCount === 1) {
          shouldSend = true;
          await addLog(env, "info", `First match from user ${authorId} – sending automatically.`);
        } else {
          if (mAutoApprove) {
            const primaryTarget = config.targets[0];
            if (primaryTarget && !mAwaitingApproval) {
              const dmChannelId = await openDmChannel(env, primaryTarget, cooldown);
              if (dmChannelId) {
                const approvalMsg =
                  `User <@${authorId}> sent a keyword message:\n` +
                  `> ${content.slice(0, 200)}\n` +
                  `Do you approve sending a response? Reply **y** or **n**`;
                await sendMessage(env, dmChannelId, approvalMsg, cooldown);
                mAwaitingApproval = {
                  author_id:       authorId,
                  message_content: content,
                  timestamp:       Date.now(),
                };
                await addLog(env, "info",
                  `Approval requested from target ${primaryTarget} for user ${authorId}.`);
              } else {
                await addLog(env, "error",
                  `Could not open DM with target ${primaryTarget}.`);
              }
            } else if (mAwaitingApproval) {
              await addLog(env, "info",
                `Already waiting for approval. Skipping user ${authorId}.`);
            } else {
              await addLog(env, "warn", "No target defined for approval.");
            }
          } else {
            await addLog(env, "warn",
              `Auto-approve disabled. Skipping user ${authorId}.`);
          }
        }

        if (shouldSend) {
          await sendMainMessage(
            env, authorId,
            config.response_message, config.gold_amount,
            config.targets, pendingTargets, cooldown
          );
          usersReceivedMain.add(authorId);
        }
      }

      // ── Inventory message condition ────────────────────────────────────────
      else if (
        config.inventory_enabled &&
        contentLower.includes(singleKeywordMatch) &&
        reactions.length > 0 &&
        !inventorySent.has(authorId) &&
        !usersReceivedMain.has(authorId)
      ) {
        const sent = await sendDm(env, authorId, config.inventory_message, cooldown);
        if (sent) {
          inventorySent.add(authorId);
          await addLog(env, "success", `Inventory message sent to user ${authorId}.`);
        } else {
          await addLog(env, "error", `Failed to send inventory message to ${authorId}.`);
        }
      }
    }
  }

  // ── Handle pending target DMs ───────────────────────────────────────────────
  const now = Date.now();

  for (const [targetUserId, info] of Object.entries(pendingTargets) as [
    string,
    PendingTarget
  ][]) {
    if (!info.active) continue;

    const dmChannelId = info.dm_channel_id;
    let messages: DiscordMessage[] = [];
    try {
      messages = await getDmMessages(env, dmChannelId, 5, cooldown);
    } catch (err) {
      await addLog(env, "error",
        `Failed to fetch DMs for target ${targetUserId}: ${String(err)}`);
      continue;
    }

    for (const msg of messages) {
      if (msg.author.id !== targetUserId) continue;
      const msgId = msg.id;
      if (seen.has(msgId)) continue;
      seen.add(msgId);

      const cmd = msg.content.trim().toLowerCase();

      // ── Approval responses ───────────────────────────────────────────────
      if (mAwaitingApproval && config.targets[0] === targetUserId) {
        if (cmd === "y" || cmd === "yes") {
          await addLog(env, "success",
            `Approval granted by ${targetUserId} for user ${mAwaitingApproval.author_id}.`);
          await sendMainMessage(
            env, mAwaitingApproval.author_id,
            config.response_message, config.gold_amount,
            config.targets, pendingTargets, cooldown
          );
          usersReceivedMain.add(mAwaitingApproval.author_id);
          mAwaitingApproval = null;
          mAutoApprove      = true;
          continue;
        } else if (cmd === "n" || cmd === "no") {
          await addLog(env, "warn", `Approval denied by target ${targetUserId}.`);
          mAwaitingApproval = null;
          mAutoApprove      = false;
          continue;
        }
      }

      // ── Commands ─────────────────────────────────────────────────────────
      if (cmd === "ok") {
        await sendMessage(env, dmChannelId, "have a nice day!", cooldown);
        pendingTargets[targetUserId].active = false;
        await addLog(env, "info", `Target ${targetUserId} said OK. Deactivated.`);
        break;
      }

      if (cmd === "down") {
        await setBotEnabled(env, false);
        await sendMessage(env, dmChannelId,
          "Bot is now offline. Use the panel to restart.", cooldown);
        await addLog(env, "warn", `Target ${targetUserId} issued DOWN. Bot disabled.`);
        await flushState(
          env, seen, pendingTargets, inventorySent, usersReceivedMain,
          mMessageCount, mAutoApprove, mAwaitingApproval
        );
        return;
      }

      if (cmd === "reset") {
        mAutoApprove  = true;
        mMessageCount = 0;
        pendingTargets[targetUserId].active = false;
        await sendMessage(env, dmChannelId,
          "Auto-approval reset! Bot will now send messages automatically again.", cooldown);
        await addLog(env, "info", `Target ${targetUserId} issued RESET.`);
        break;
      }
    }

    // ── Periodic "order is ready" ping ────────────────────────────────────
    if (
      info.active &&
      now - info.last_ping >= config.ping_interval_seconds * 1000
    ) {
      const sent = await sendMessage(
        env, dmChannelId, `order is ready <@${targetUserId}>`, cooldown
      );
      if (sent) {
        pendingTargets[targetUserId].last_ping = now;
        await addLog(env, "info",
          `Resent "order is ready" ping to target ${targetUserId}.`);
      }
    }
  }

  // ── Persist all state ───────────────────────────────────────────────────────
  await flushState(
    env, seen, pendingTargets, inventorySent, usersReceivedMain,
    mMessageCount, mAutoApprove, mAwaitingApproval
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendMainMessage(
  env:            Env,
  authorId:       string,
  responseMessage: string,
  goldAmount:     string,
  targetUserIds:  string[],
  pendingTargets: Record<string, PendingTarget>,
  cooldown:       ResourceCooldown
): Promise<void> {
  const customMessage = `${responseMessage}\nGold: ${goldAmount}`;
  const sent = await sendDm(env, authorId, customMessage, cooldown);

  if (sent) {
    await addLog(env, "success", `Main message sent to user ${authorId}.`);
    for (const targetId of targetUserIds) {
      const dmChannelId = await openDmChannel(env, targetId, cooldown);
      if (!dmChannelId) {
        await addLog(env, "error", `Could not open DM with target ${targetId}.`);
        continue;
      }
      const orderMsg = `order is ready <@${targetId}>`;
      await sendMessage(env, dmChannelId, orderMsg, cooldown);
      pendingTargets[targetId] = {
        dm_channel_id: dmChannelId,
        last_ping:     Date.now(),
        active:        true,
      };
      await addLog(env, "info", `Sent "order is ready" to target ${targetId}.`);
    }
  } else {
    await addLog(env, "error", `Failed to send main message to user ${authorId}.`);
  }
}

async function flushState(
  env:              Env,
  seen:             Set<string>,
  pendingTargets:   Record<string, PendingTarget>,
  inventorySent:    Set<string>,
  usersReceivedMain: Set<string>,
  messageCount:     number,
  autoApprove:      boolean,
  awaitingApproval: import("./types.js").AwaitingApproval | null
): Promise<void> {
  await Promise.all([
    saveSeenMessages(env, seen),
    savePendingTargets(env, pendingTargets),
    saveInventorySent(env, inventorySent),
    saveUsersReceivedMain(env, usersReceivedMain),
    saveMessageCount(env, messageCount),
    saveAutoApprove(env, autoApprove),
    saveAwaitingApproval(env, awaitingApproval),
  ]);
}
