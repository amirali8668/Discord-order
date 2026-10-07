/**
 * monitor.ts – M+ Boost Monitoring cron orchestrator (v3).
 *
 * KEY CHANGES v3:
 *
 * UNIFIED PER-TICK GUILD CHANNEL CACHE
 *   A single Map<guildId, DiscordChannel[]> is built ONCE at the start of
 *   reconcileCategories and reused by both the guild-level loop (Step A) and
 *   the category-level loop (Step B).  Each guild is queried exactly once per
 *   cron tick regardless of how many categories belong to it.
 *
 * FRESH DATA FOR RECONCILIATION (skipCache=true)
 *   Guild channel lists used for reconciliation bypass the 5-min metadata
 *   cache so that newly-created and deleted channels are detected within the
 *   same cron tick they change on Discord.  The cache is still populated from
 *   the response, so any non-reconciliation caller in the same tick still
 *   benefits from the cache.
 *
 * DELETED CHANNEL DEACTIVATION
 *   Any channel present in D1 (active=1) but absent from the fresh Discord
 *   channel list is immediately marked deleted (active=0, monitoring=0) and
 *   its live boosts are expired.  Historical boost/message/acceptance records
 *   are preserved unchanged.
 *
 * AUTHORITATIVE RECONCILIATION ALGORITHM
 *   For each guild:
 *     remote = fresh channel list from Discord
 *     local  = channels stored in D1 for that guild (active=1)
 *     remoteIds = Set of remote channel IDs
 *
 *     for each remote channel:
 *       if not in local → create
 *       if in local + name changed → update
 *       (active channels that exist in both → no-op)
 *
 *     for each local channel:
 *       if not in remoteIds → deactivate (mark deleted)
 */

import type { Env, MonitoringConfig, MonitoringConfigRow } from "./types.js";
import {
  getMonitoringConfig,
  getMonitoredCategories,
  getMonitoredGuilds,
  getActiveMonitoredChannels,
  getAllChannels,
  getChannel,
  upsertGuild,
  upsertCategory,
  markChannelDeleted,
  touchGuild,
  insertMplusLog,
  getBoost,
  setGuildMonitoring,
  setCategoryMonitoring,
} from "./db.js";
import {
  fetchGuild,
  fetchCategoryChildren,
  fetchChannel,
  resolveDiscordId,
  fetchGuildChannels,
} from "./discord-api.js";
import type { DiscordChannel } from "./types.js";
import { registerChannel } from "./matching.js";
import { attemptBoostSend } from "./boost-machine.js";
import { broadcastEvent } from "./monitor-do.js";
import { sendTelegramNewBoost, sendTelegramNewChannel } from "./telegram.js";
import { pollSentBoostsForAcceptance } from "./poller.js";
import { ResourceCooldown } from "./resource-cooldown.js";
import { guildKey } from "./resource-cooldown.js";

// ─── Config row → typed config ────────────────────────────────────────────────

export function rowToConfig(row: MonitoringConfigRow): MonitoringConfig {
  return {
    enabled:               row.enabled === 1,
    minLevel:              row.min_level,
    maxLevel:              row.max_level,
    messageTemplate:       row.message_template,
    acceptanceMode:        row.acceptance_mode,
    acceptedReactions:     row.accepted_reactions.split(",").map((r) => r.trim()).filter(Boolean),
    mentionTargetId:       row.mention_target_id,
    acceptReaction:        row.accept_reaction === 1,
    acceptMention:         row.accept_mention === 1,
    anyReactionAccepted:   ((row.any_reaction_accepted)  ?? 1) === 1,
    pausedAfterAccept:     ((row.paused_after_accept)    ?? 1) === 1,
    paused:                ((row.paused)                 ?? 0) === 1,
    pausedForConfirmation: ((row.paused_for_confirmation) ?? 0) === 1,
    lastAcceptedBoostId:   row.last_accepted_boost_id   ?? null,
    notificationChannelId: row.notification_channel_id  ?? null,
    // Timing — fall back to safe defaults if columns not yet migrated
    discoveryIntervalSec:  (row.discovery_interval_sec ?? 5),
    signDelaySec:          (row.sign_delay_sec          ?? 3),
    queueDelaySec:         (row.queue_delay_sec         ?? 2),
  };
}

// ─── Main monitor tick (cron, every 1 min) ────────────────────────────────────
/**
 * runMonitorTick — called by the cron trigger every minute.
 * Responsibilities:
 *   1. Poll SENT boosts for acceptance
 *   2. Process active monitored channels (attempt boost sends with 3s delay)
 *   3. Ensure the 5-second discovery alarm is running in the DO
 *
 * Channel discovery (reconcileCategories) is now handled by runChannelDiscovery()
 * which is called every 5 seconds via DO Alarm — NOT here.
 */

export async function runMonitorTick(env: Env): Promise<void> {
  let cfgRow: MonitoringConfigRow;
  try {
    cfgRow = await getMonitoringConfig(env);
  } catch (err) {
    console.warn("[monitor] D1 not ready:", String(err));
    return;
  }

  const config = rowToConfig(cfgRow);
  if (!config.enabled) return;

  const cooldown = new ResourceCooldown(env);

  // ── Step 1: Poll SENT boosts for acceptance ───────────────────────────────
  await pollSentBoostsForAcceptance(env, config, cooldown);

  // Re-read config in case acceptance changed it
  const updatedCfgRow = await getMonitoringConfig(env);
  const updatedConfig = rowToConfig(updatedCfgRow);

  // ── Step 2: Process active monitored channels (with 3s sign delay) ────────
  await processActiveChannels(env, updatedConfig, cooldown);

  // ── Step 3: Ensure 5s discovery alarm is running in the DO ───────────────
  const { ensureDiscoveryAlarm } = await import("./monitor-do.js");
  await ensureDiscoveryAlarm(env);
}

/**
 * runChannelDiscovery — called every 5 seconds by the DO Alarm.
 * Only reconciles guild/category/channel state.
 * Does NOT send any messages (that happens in runMonitorTick / processActiveChannels).
 */
export async function runChannelDiscovery(env: Env): Promise<void> {
  let cfgRow: MonitoringConfigRow;
  try {
    cfgRow = await getMonitoringConfig(env);
  } catch {
    return; // D1 not ready
  }

  const config = rowToConfig(cfgRow);
  if (!config.enabled) return;

  const cooldown = new ResourceCooldown(env);
  await reconcileCategories(env, config, cooldown);
}

// ─── Category reconciliation ──────────────────────────────────────────────────

/**
 * Full guild/category/channel reconciliation — runs every cron tick.
 *
 * ALGORITHM (per guild):
 *   1. Fetch ALL Discord channels for the guild with skipCache=true (fresh data).
 *   2. Build a Set of remote channel IDs.
 *   3. For each remote category:
 *        - register in DB if new
 *        - for each remote text channel under that category:
 *            * create in DB if new
 *            * update name in DB if renamed
 *   4. For each local active channel under that guild:
 *        - if its ID is NOT in the remote set → deactivate it
 *
 * This runs for BOTH guild-level registrations (type=guild) and
 * category-level registrations (type=category).  The same guild is
 * fetched exactly ONCE per tick thanks to the shared guildChannelsCache.
 */
async function reconcileCategories(
  env:      Env,
  config:   MonitoringConfig,
  cooldown: ResourceCooldown
): Promise<void> {

  // ── 0. Collect all guild IDs we need to reconcile ────────────────────────
  // Sources: monitored guilds + guilds that have monitored categories.
  const monitoredGuilds     = await getMonitoredGuilds(env);
  const monitoredCategories = await getMonitoredCategories(env);

  const guildIdsFromCategories = new Set(monitoredCategories.map((c) => c.guild_id));
  // Merge: start with guild-level registrations, then add category-guild IDs.
  const allGuildIds = new Set<string>([
    ...monitoredGuilds.map((g) => g.id),
    ...guildIdsFromCategories,
  ]);

  if (allGuildIds.size === 0) return;

  // ── 1. Build shared per-tick guild channels cache ─────────────────────────
  // Each guild is fetched exactly ONCE, with skipCache=true so reconcile
  // always uses fresh data (not the 5-min TTL metadata cache).
  const guildChannelsCache = new Map<string, DiscordChannel[]>();
  const guildInfoCache     = new Map<string, { id: string; name: string; icon: string | null }>();

  for (const guildId of allGuildIds) {
    if (await cooldown.isOnCooldown(guildKey(guildId))) {
      console.log(`[monitor] Guild ${guildId} on cooldown — skipping reconcile`);
      guildChannelsCache.set(guildId, []);
      continue;
    }

    // skipCache=true → bypass 5-min cache so new/deleted channels are visible immediately
    const channels = await fetchGuildChannels(env, guildId, "LOW", cooldown, true);
    guildChannelsCache.set(guildId, channels);

    // Also refresh guild metadata (name/icon) while we're at it
    const guild = await fetchGuild(env, guildId, "MEDIUM", cooldown);
    if (guild) {
      guildInfoCache.set(guildId, { id: guild.id, name: guild.name, icon: guild.icon ?? null });
      await upsertGuild(env, guild.id, guild.name, guild.icon ?? null);
    }
  }

  // ── 2. Full reconcile per guild ────────────────────────────────────────────
  for (const guildId of allGuildIds) {
    const allDiscordChannels = guildChannelsCache.get(guildId) ?? [];
    const guildInfo          = guildInfoCache.get(guildId);

    // If we got no channels (cooldown, 403, 404, or genuinely empty), skip
    // the reconcile for this guild so we don't accidentally deactivate everything.
    if (allDiscordChannels.length === 0) continue;

    const guildName = guildInfo?.name ?? guildId;

    // Build set of all remote channel IDs (categories + text channels)
    const remoteIds = new Set(allDiscordChannels.map((ch) => ch.id));

    // ── 2a. Register / update categories found on Discord ─────────────────
    const discordCategories = allDiscordChannels.filter((ch) => ch.type === 4);

    for (const cat of discordCategories) {
      const catName = cat.name ?? cat.id;

      // Upsert category (idempotent — creates if missing, updates name if changed)
      await upsertCategory(env, cat.id, guildId, catName);

      // Ensure monitoring is enabled for this category if its guild is monitored
      const isGuildMonitored = monitoredGuilds.some((g) => g.id === guildId);
      if (isGuildMonitored) {
        const catResult = await env.DB
          .query(`SELECT monitoring FROM categories WHERE id = $1`, [cat.id]);
        const existingCat = catResult.rows[0] as { monitoring: number } | undefined;
        if (existingCat && existingCat.monitoring === 0) {
          await setCategoryMonitoring(env, cat.id, true);
        } else if (!existingCat) {
          await setCategoryMonitoring(env, cat.id, true);
          await insertMplusLog(env, "info", "CATEGORY_DISCOVERED",
            `Auto-registered new category #${catName} (${cat.id}) for guild ${guildName}.`,
            { guildId });
        }
      }

      // ── 2b. Register / update text channels under this category ──────────
      const liveChildren = allDiscordChannels.filter(
        (ch) => ch.type === 0 && ch.parent_id === cat.id
      );

      for (const ch of liveChildren) {
        const chName   = ch.name ?? ch.id;
        const existing = await getChannel(env, ch.id);

        if (!existing) {
          // Brand-new channel — register it
          await handleChannelCreate(
            env, ch.id, chName, guildId, guildName,
            cat.id, catName, ch.type, config
          );
        } else if (!existing.active) {
          // Channel existed before, was deleted, now it's back — reactivate
          await env.DB.query(
            `UPDATE channels SET active = 1, monitoring = 1, name = $1,
             guild_name = $2, category_name = $3, updated_at = $4 WHERE id = $5`,
            [chName, guildName, catName, Math.floor(Date.now() / 1000), ch.id]
          );
          await insertMplusLog(env, "info", "CHANNEL_CREATE",
            `Channel #${chName} (${ch.id}) reactivated — it reappeared in Discord.`,
            { channelId: ch.id, guildId });
        } else if (existing.name !== chName) {
          // Channel was renamed
          await handleChannelUpdate(
            env, ch.id, chName, guildId, guildName,
            cat.id, catName, ch.type, config
          );
        }
        // else: channel exists, is active, name unchanged — no-op
      }
    }

    // ── 2c. Deactivate local channels that no longer exist on Discord ──────
    // Fetch ALL active channels for this guild from D1 (regardless of category)
    const localActiveChannels = await getAllChannels(env, { guildId, active: true });

    for (const localCh of localActiveChannels) {
      if (!remoteIds.has(localCh.id)) {
        // Channel is in DB (active) but NOT in the fresh Discord channel list
        // → it was deleted from Discord → deactivate it
        await handleChannelDelete(env, localCh.id, config);
      }
    }
  }

  // ── 3. Also reconcile category-monitored guilds that are NOT in monitoredGuilds
  //     (they have categories monitored directly, not via guild-level monitoring)
  // Step 2 already handles all guildIds including those from categories, but we
  // need to also ensure deleted categories are deactivated. ─────────────────
  for (const cat of monitoredCategories) {
    const allDiscordChannels = guildChannelsCache.get(cat.guild_id) ?? [];
    if (allDiscordChannels.length === 0) continue;

    const remoteIds = new Set(allDiscordChannels.map((ch) => ch.id));

    // If the category itself no longer exists on Discord, deactivate it
    if (!remoteIds.has(cat.id)) {
      await setCategoryMonitoring(env, cat.id, false);
      await insertMplusLog(env, "info", "CHANNEL_DELETE",
        `Category ${cat.id} (#${cat.name}) no longer exists on Discord — deactivated.`,
        { guildId: cat.guild_id });
      // Channels under it will have been caught in step 2c already
    }
  }
}

// ─── Process active channels ──────────────────────────────────────────────────

/**
 * Process active monitored channels and send Sign messages.
 *
 * QUEUING BEHAVIOR:
 *   - 1 eligible channel  → send immediately (no delay)
 *   - N>1 eligible channels → queue:
 *       first channel  → send immediately
 *       each subsequent → 2 seconds after the previous
 *
 * Duplicate prevention: channels already processed in the same tick
 * (already have a SENT/ACCEPTED boost via fingerprint check in evaluateChannelForSent)
 * are naturally skipped — no separate dedup needed here.
 *
 * Invalid/deleted check before each send: the existing `signDelayMs>0` path in
 * `attemptBoostSend` re-checks eligibility after the delay.  For the first (no-delay)
 * send, eligibility was already confirmed by `evaluateChannelForSent` inside
 * `attemptBoostSend`.
 */


async function processActiveChannels(
  env:      Env,
  config:   MonitoringConfig,
  cooldown: ResourceCooldown
): Promise<void> {
  if (config.pausedForConfirmation) return;

  const channels = await getActiveMonitoredChannels(env);
  if (channels.length === 0) return;

  // ── Single channel: send with configured sign delay (or 0 if delay=0) ──────
  if (channels.length === 1) {
    const channel = channels[0];
    const delayMs = (config.signDelaySec ?? 3) * 1000;
    try {
      const result = await attemptBoostSend(env, channel, config, cooldown, delayMs);
      if (result.success && result.boostId) {
        const boost = await getBoost(env, result.boostId);
        if (boost) {
          sendTelegramNewBoost(env,
            boost.id, boost.channel_name, boost.guild_name, boost.guild_id,
            boost.category_name, boost.customer, boost.level, boost.count,
            boost.boost_type, boost.outgoing_message_content ?? ""
          ).catch(() => {});
        }
        await insertMplusLog(env, "info", "SYSTEM",
          `Tick complete: sent boost message to 1 channel. Monitoring continues.`);
      }
    } catch (err) {
      await insertMplusLog(env, "error", "API_ERROR",
        `Error processing channel ${channel.id}: ${String(err)}`,
        { channelId: channel.id, guildId: channel.guild_id });
    }
    return;
  }

  // ── Multiple channels: queue with configured inter-send delay ─────────────
  // First channel: send after signDelaySec (or 0)
  // Each subsequent channel: signDelaySec + (position * queueDelaySec)
  // Actually: first gets signDelaySec delay, rest get QUEUE_BETWEEN_DELAY after prev.
  // Per spec: first is "immediate" (signDelaySec=0 means immediate for single,
  //   but for queue the signDelay applies to the first and queueDelay between others).
  //
  // Implementation: pass signDelaySec*1000 for first, queueDelaySec*1000 for subsequent.
  let sentCount = 0;
  let isFirst   = true;

  for (const channel of channels) {
    try {
      // First in queue: apply sign delay; subsequent: apply queue delay
      const delayMs = isFirst
        ? (config.signDelaySec ?? 3) * 1000
        : (config.queueDelaySec ?? 2) * 1000;
      isFirst = false;

      const result = await attemptBoostSend(env, channel, config, cooldown, delayMs);

      if (result.success && result.boostId) {
        sentCount++;
        const boost = await getBoost(env, result.boostId);
        if (boost) {
          sendTelegramNewBoost(env,
            boost.id, boost.channel_name, boost.guild_name, boost.guild_id,
            boost.category_name, boost.customer, boost.level, boost.count,
            boost.boost_type, boost.outgoing_message_content ?? ""
          ).catch(() => {});
        }
      }
    } catch (err) {
      await insertMplusLog(env, "error", "API_ERROR",
        `Error processing channel ${channel.id}: ${String(err)}`,
        { channelId: channel.id, guildId: channel.guild_id });
    }
  }

  if (sentCount > 0) {
    await insertMplusLog(env, "info", "SYSTEM",
      `Tick complete: sent boost messages to ${sentCount} channel(s). Monitoring continues.`);
  }
}

// ─── Channel lifecycle handlers ───────────────────────────────────────────────

export async function handleChannelCreate(
  env:          Env,
  channelId:    string,
  channelName:  string,
  guildId:      string,
  guildName:    string,
  categoryId:   string | null,
  categoryName: string | null,
  channelType:  number,
  config:       MonitoringConfig
): Promise<void> {
  const row = await registerChannel(
    env, channelId, channelName, guildId, guildName,
    categoryId, categoryName, channelType, config
  );

  await touchGuild(env, guildId);

  await insertMplusLog(env, "info", "CHANNEL_CREATE",
    `New channel #${channelName} (${channelId}) in category ${categoryId ?? "none"}`,
    { channelId, guildId });

  await broadcastEvent(env, {
    type: "CHANNEL_CREATED",
    payload: {
      channelId, channelName, guildId, guildName, categoryId, categoryName,
      parsed: row.parsed, parseStatus: row.parse_status,
      boostType: row.boost_type, level: row.boost_level,
      count: row.boost_count, customer: row.customer,
    },
    timestamp: Date.now(),
  });

  if (row.monitoring && row.parsed) {
    const parsedInfo = `type=${row.boost_type} count=${row.boost_count} level=${row.boost_level} customer=${row.customer}`;
    await sendTelegramNewChannel(
      env, channelId, channelName, guildName, guildId,
      categoryName, categoryId, parsedInfo
    ).catch(() => {});
  }
}

export async function handleChannelUpdate(
  env:          Env,
  channelId:    string,
  newName:      string,
  guildId:      string,
  guildName:    string,
  categoryId:   string | null,
  categoryName: string | null,
  channelType:  number,
  config:       MonitoringConfig
): Promise<void> {
  const row = await registerChannel(
    env, channelId, newName, guildId, guildName,
    categoryId, categoryName, channelType, config
  );

  await insertMplusLog(env, "info", "CHANNEL_UPDATE",
    `Channel ${channelId} renamed to #${newName}`, { channelId, guildId });

  await broadcastEvent(env, {
    type: "CHANNEL_UPDATED",
    payload: {
      channelId, channelName: newName, guildId,
      parsed: row.parsed, parseStatus: row.parse_status,
      boostType: row.boost_type, level: row.boost_level,
      count: row.boost_count, customer: row.customer,
    },
    timestamp: Date.now(),
  });
}

export async function handleChannelDelete(
  env:      Env,
  channelId: string,
  _config:  MonitoringConfig
): Promise<void> {
  const existing = await getChannel(env, channelId);
  if (!existing || !existing.active) return;

  await markChannelDeleted(env, channelId);

  await env.DB.query(
    `UPDATE boosts SET status = 'EXPIRED' WHERE channel_id = $1 AND status IN ('SENT','WAITING')`,
    [channelId]
  ).catch(() => {});

  await insertMplusLog(env, "info", "CHANNEL_DELETE",
    `Channel ${channelId} (#${existing.name}) marked as deleted. Any SENT boosts expired.`,
    { channelId, guildId: existing.guild_id });

  await broadcastEvent(env, {
    type: "CHANNEL_DELETED",
    payload: { channelId, channelName: existing.name, guildId: existing.guild_id },
    timestamp: Date.now(),
  });
}

// ─── Resolve and register a Discord ID ───────────────────────────────────────

export async function resolveAndRegister(
  env:      Env,
  discordId: string,
  config:   MonitoringConfig
): Promise<{ type: string; guildId: string; guildName: string; resourceName: string }> {
  // API-triggered resolve — no cooldown needed (admin action, one-shot)
  const resolved = await resolveDiscordId(env, discordId);
  if (!resolved) {
    throw new Error(
      `Could not resolve Discord ID: ${discordId}. Check the ID and token permissions.`
    );
  }

  await upsertGuild(env, resolved.guildId, resolved.guildName);
  await setGuildMonitoring(env, resolved.guildId, true);

  if (resolved.type === "guild") {
    await insertMplusLog(env, "info", "GUILD_DISCOVERED",
      `Guild ${resolved.guildName} (${resolved.guildId}) registered for monitoring.`,
      { guildId: resolved.guildId });
    return {
      type: "guild", guildId: resolved.guildId,
      guildName: resolved.guildName, resourceName: resolved.guildName,
    };
  }

  if (resolved.type === "category") {
    const catId   = resolved.resourceId;
    const catName = resolved.resourceName;

    await upsertCategory(env, catId, resolved.guildId, catName);
    await setCategoryMonitoring(env, catId, true);

    const children = await fetchCategoryChildren(env, catId, resolved.guildId);
    for (const ch of children) {
      await handleChannelCreate(
        env, ch.id, ch.name ?? ch.id,
        resolved.guildId, resolved.guildName,
        catId, catName, ch.type, config
      );
    }

    await insertMplusLog(env, "info", "CATEGORY_DISCOVERED",
      `Category #${catName} (${catId}) registered. Discovered ${children.length} child channels.`,
      { guildId: resolved.guildId });

    return {
      type: "category", guildId: resolved.guildId,
      guildName: resolved.guildName, resourceName: catName,
    };
  }

  // type === "channel"
  const ch = await fetchChannel(env, resolved.resourceId);
  if (!ch) throw new Error(`Channel ${resolved.resourceId} not accessible.`);

  const catId = ch.parent_id ?? null;
  let catName: string | null = null;
  if (catId) {
    const catCh = await fetchChannel(env, catId);
    catName = catCh?.name ?? null;
    if (catCh) {
      await upsertCategory(env, catId, resolved.guildId, catName ?? catId);
    }
  }

  await registerChannel(
    env, resolved.resourceId, resolved.resourceName,
    resolved.guildId, resolved.guildName,
    catId, catName, ch.type, config
  );

  await env.DB.query(
    `UPDATE channels SET monitoring = 1, updated_at = $1 WHERE id = $2`,
    [Math.floor(Date.now() / 1000), resolved.resourceId]
  );

  await insertMplusLog(env, "info", "CHANNEL_DISCOVERED",
    `Channel #${resolved.resourceName} (${resolved.resourceId}) registered directly.`,
    { channelId: resolved.resourceId, guildId: resolved.guildId });

  return {
    type: "channel", guildId: resolved.guildId,
    guildName: resolved.guildName, resourceName: resolved.resourceName,
  };
}

