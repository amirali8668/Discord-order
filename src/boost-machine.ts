/**
 * boost-machine.ts – Boost state machine (v3 – cooldown-aware send).
 *
 * CHANGES v3:
 *  - attemptBoostSend accepts an optional ResourceCooldown instance.
 *    Before sending, it checks whether the channel is on cooldown.
 *    After a permanent send failure (403/404), it records a cooldown so
 *    the same channel is NOT retried every cron tick.
 *  - sendChannelMessage now returns a SendResult (permanent flag).
 *
 * CORRECT FLOW (unchanged):
 *   INACTIVE → (admin enables) → ACTIVE
 *   ACTIVE   → (matching channel found + message sent) → SENT
 *   SENT     → (valid reaction or mention) → ACCEPTED
 *   ACCEPTED → PAUSED_FOR_CONFIRMATION → (admin CONTINUE) → ACTIVE
 */

import type {
  Env,
  ChannelRow,
  MonitoringConfig,
  MonitoringState,
} from "./types.js";
import {
  newId,
  createBoost,
  updateBoostSent,
  updateBoostStatus,
  insertMessage,
  insertMplusLog,
  updateMonitoringConfig,
  setPausedForConfirmation,
  setLastAcceptedBoost,
  markChannelDeleted,
} from "./db.js";
import { evaluateChannelForSent, renderTemplate } from "./matching.js";
import { sendChannelMessage }                     from "./discord-api.js";
import { broadcastEvent }                         from "./monitor-do.js";
import type { ResourceCooldown }                  from "./resource-cooldown.js";
import { channelKey }                             from "./resource-cooldown.js";
import { isChannelFresh }                         from "./channel-freshness.js";

// ─── Enable / Disable ─────────────────────────────────────────────────────────

export async function enableMonitoring(env: Env): Promise<void> {
  await updateMonitoringConfig(env, { enabled: 1, paused: 0, paused_for_confirmation: 0 });
  await broadcastEvent(env, {
    type: "MONITORING_CHANGED",
    payload: { state: "ACTIVE" },
    timestamp: Date.now(),
  });
  await insertMplusLog(env, "info", "CONFIG_CHANGED", "Monitoring enabled.");
}

export async function disableMonitoring(env: Env): Promise<void> {
  await updateMonitoringConfig(env, { enabled: 0 });
  await broadcastEvent(env, {
    type: "MONITORING_CHANGED",
    payload: { state: "INACTIVE" },
    timestamp: Date.now(),
  });
  await insertMplusLog(env, "info", "CONFIG_CHANGED", "Monitoring disabled.");
}

// ─── Current monitoring state ─────────────────────────────────────────────────

export async function getMonitoringState(
  _env: Env,
  config: MonitoringConfig
): Promise<MonitoringState> {
  if (!config.enabled)             return "INACTIVE";
  if (config.pausedForConfirmation) return "PAUSED_FOR_CONFIRMATION";
  return "ACTIVE";
}

// ─── Resume after acceptance (CONTINUE button) ───────────────────────────────

export async function resumeAfterAcceptance(env: Env): Promise<void> {
  await setPausedForConfirmation(env, false);
  await setLastAcceptedBoost(env, null);
  await broadcastEvent(env, {
    type: "MONITORING_CHANGED",
    payload: { state: "ACTIVE", paused: false },
    timestamp: Date.now(),
  });
  await insertMplusLog(env, "info", "SYSTEM",
    "Monitoring resumed by admin (CONTINUE). Ready for next boost.");
}

// ─── Attempt to send boost message for one channel ───────────────────────────

export interface BoostSendResult {
  success:  boolean;
  boostId?: string;
  skipped?: boolean;
  reason?:  string;
}

/**
 * Evaluate a channel and send the boost message if eligible.
 *
 * COOLDOWN BEHAVIOR:
 *   - If the channel is on cooldown (previous 403/404 send failure), skip
 *     immediately — no D1 boost record created, no Discord request made.
 *   - If sendChannelMessage returns a permanent error (403/404), record a
 *     cooldown so the channel is not retried for 30 minutes.
 *
 * STATE MACHINE GUARANTEES (unchanged):
 *   - Sending a message does NOT pause monitoring.
 *   - Multiple channels can be in SENT state simultaneously.
 *   - PAUSED_FOR_CONFIRMATION only happens after a valid acceptance.
 */
export async function attemptBoostSend(
  env:       Env,
  channel:   ChannelRow,
  config:    MonitoringConfig,
  cooldown?: ResourceCooldown,
  /** Delay in ms before sending the sign message (default 0 = immediate) */
  signDelayMs = 0
): Promise<BoostSendResult> {
  // ── 0. Cooldown guard (NEW) ───────────────────────────────────────────────
  if (cooldown) {
    const rk = channelKey(channel.id);
    if (await cooldown.isOnCooldown(rk)) {
      return {
        success: false,
        skipped: true,
        reason:  `Channel ${channel.id} on cooldown — ${cooldown.cooldownReason(rk)}`,
      };
    }
  }

  // ── 1. Check eligibility ─────────────────────────────────────────────────
  const match = await evaluateChannelForSent(env, channel, config);
  if (!match.matched) {
    return { success: false, skipped: true, reason: match.reason };
  }

  // ── 1b. Channel freshness check (4-minute rule) ───────────────────────────
  // Fetch the first and last message timestamps of the channel.
  // If last - first > 4 minutes → channel is OLD → do not send.
  // This happens BEFORE creating a boost record so no partial records exist.
  const freshness = await isChannelFresh(env, channel.id, cooldown);
  if (!freshness.fresh) {
    // Log with enough detail to understand why, but avoid log spam:
    // Only log at "info" level (not error) since this is expected behavior.
    await insertMplusLog(env, "info", "BOOST_IGNORED",
      `Channel #${channel.name} (${channel.id}) skipped — old channel: ${freshness.reason}`,
      { channelId: channel.id, guildId: channel.guild_id }
    );
    return {
      success: false,
      skipped: true,
      reason:  `OLD_CHANNEL: ${freshness.reason}`,
    };
  }

  const boostId = newId();
  const now     = Date.now();

  // ── Sign delay (3s for newly discovered channels) ─────────────────────────
  // This small wait lets Discord propagate channel state and prevents races
  // where the channel disappears in the 3 seconds between discovery and send.
  if (signDelayMs > 0) {
    await new Promise<void>((r) => setTimeout(r, signDelayMs));

    // Re-check eligibility after the delay: channel might have been deleted
    // or already processed by a parallel tick.
    const recheckMatch = await evaluateChannelForSent(env, channel, config);
    if (!recheckMatch.matched) {
      return { success: false, skipped: true, reason: `Post-delay recheck: ${recheckMatch.reason}` };
    }
  }

  // ── 2. Create boost record (ACTIVE) ──────────────────────────────────────
  await createBoost(env, {
    id:           boostId,
    guild_id:     channel.guild_id,
    guild_name:   channel.guild_name,
    category_id:  channel.category_id,
    category_name: channel.category_name,
    channel_id:   channel.id,
    channel_name: channel.name,
    customer:     match.customer,
    level:        match.level,
    count:        match.count,
    boost_type:   match.type,
    fingerprint:  match.fingerprint,
    status:       "ACTIVE",
    created_at:   now,
    notif_sent:   0,
  });

  // ── 3. Render message template ────────────────────────────────────────────
  const content = renderTemplate(config.messageTemplate, {
    server:     channel.guild_name,
    guild:      channel.guild_id,
    category:   channel.category_name ?? "",
    channel:    channel.name,
    channel_id: channel.id,
    customer:   match.customer,
    level:      match.level,
    count:      match.count,
    type:       match.type,
    timestamp:  new Date(now).toISOString(),
  });

  // ── 4. Send message into the matching channel ─────────────────────────────
  const sendResult = await sendChannelMessage(
    env, channel.id, content, cooldown
  );

  if (!sendResult.message) {
    // Mark boost as ERROR
    await updateBoostStatus(env, boostId, "ERROR");

    // If the channel no longer exists (404) or we have no permission (403),
    // mark it as deleted/inactive in D1 so future ticks skip it immediately.
    // Historical data (the boost record we just created) is preserved as ERROR.
    if (sendResult.permanent && (sendResult.status === 404 || sendResult.status === 403)) {
      await markChannelDeleted(env, channel.id);
      await insertMplusLog(env, "warn", "CHANNEL_DELETE",
        `Channel #${channel.name} (${channel.id}) auto-deactivated after HTTP ${sendResult.status} on send — will no longer be processed.`,
        { channelId: channel.id, guildId: channel.guild_id, boostId }
      );
    } else {
      await insertMplusLog(env, "error", "MESSAGE_SEND_FAILED",
        `Failed to send message to channel ${channel.id} (#${channel.name})` +
        (sendResult.permanent ? ` [permanent ${sendResult.status} — cooldown applied]` : ""), {
          channelId: channel.id, guildId: channel.guild_id, boostId,
        });
    }

    return {
      success: false,
      reason:  sendResult.permanent
        ? `Permanent send failure HTTP ${sendResult.status} — channel deactivated`
        : "Message send failed",
    };
  }

  // ── 5. Update boost to SENT ───────────────────────────────────────────────
  await updateBoostSent(env, boostId, sendResult.message.id, content);
  await env.DB.query(`UPDATE boosts SET status = 'SENT' WHERE id = ?`, [boostId]);

  await insertMessage(env, sendResult.message.id, boostId,
    channel.guild_id, channel.category_id, channel.id, content);

  await insertMplusLog(env, "success", "MESSAGE_SENT",
    `Message sent to #${channel.name} (${channel.id}), msg_id=${sendResult.message.id}. Monitoring continues.`, {
      channelId: channel.id, guildId: channel.guild_id, boostId,
    });

  // ── 6. Broadcast ──────────────────────────────────────────────────────────
  await broadcastEvent(env, {
    type: "BOOST_WAITING",
    payload: {
      boostId,
      channelId:        channel.id,
      channelName:      channel.name,
      customer:         match.customer,
      level:            match.level,
      count:            match.count,
      type:             match.type,
      outgoingMessageId: sendResult.message.id,
      content,
      note:             "Message sent — monitoring continues for acceptance",
    },
    timestamp: now,
  });

  return { success: true, boostId };
}

// ─── Transition to PAUSED_FOR_CONFIRMATION (called from acceptance.ts) ────────

export async function transitionToAccepted(
  env:     Env,
  boostId: string
): Promise<void> {
  await setPausedForConfirmation(env, true);
  await setLastAcceptedBoost(env, boostId);

  await broadcastEvent(env, {
    type: "BOOST_ACCEPTED",
    payload: { boostId },
    timestamp: Date.now(),
  });

  await broadcastEvent(env, {
    type: "MONITORING_CHANGED",
    payload: { state: "PAUSED_FOR_CONFIRMATION", boostId },
    timestamp: Date.now(),
  });

  await insertMplusLog(env, "success", "SYSTEM",
    `Boost ${boostId} ACCEPTED. System PAUSED_FOR_CONFIRMATION — waiting for admin CONTINUE.`,
    { boostId });
}

