/**
 * gateway.ts – Discord Gateway event handler.
 *
 * Since Cloudflare Workers cannot maintain a persistent WebSocket to Discord,
 * this module handles incoming Discord events via two mechanisms:
 *
 *   1. HTTP Webhook (POST /gateway/event)
 *      Set up an "Outgoing Webhook" integration in Discord to POST events here.
 *      This is the recommended approach for Workers.
 *
 *   2. REST reconciliation (cron tick in monitor.ts)
 *      The cron tick polls channels and reconciles state every minute.
 *      This acts as a fallback / recovery mechanism.
 *
 * Supported Discord Gateway event types received via webhook:
 *   MESSAGE_REACTION_ADD    → acceptance detection (REACTION)
 *   MESSAGE_CREATE          → acceptance detection (MENTION)
 *   CHANNEL_CREATE          → register new channel under monitored category
 *   CHANNEL_UPDATE          → refresh channel metadata + reparse
 *   CHANNEL_DELETE          → mark channel deleted
 *
 * Security:
 *   Each event is verified using the configured DISCORD_PUBLIC_KEY secret
 *   (Ed25519 signature verification as required by Discord Interactions).
 *   Events without a valid signature are rejected with 401.
 *
 * Idempotency:
 *   All event handlers are idempotent.
 *   Duplicate events produce no side effects.
 */

import type {
  Env,
  DiscordReactionEvent,
  DiscordMessageEvent,
} from "./types.js";
import { getMonitoringConfig } from "./db.js";
import { rowToConfig } from "./monitor.js";
import { handleReactionAdd, handleMessageCreate } from "./acceptance.js";
import { handleChannelCreate, handleChannelUpdate, handleChannelDelete } from "./monitor.js";
import { insertMplusLog } from "./db.js";
import { fetchGuild, fetchChannel } from "./discord-api.js";

// ─── Discord event type constants ─────────────────────────────────────────────

const DISCORD_EVENTS = {
  MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
  MESSAGE_CREATE:       "MESSAGE_CREATE",
  CHANNEL_CREATE:       "CHANNEL_CREATE",
  CHANNEL_UPDATE:       "CHANNEL_UPDATE",
  CHANNEL_DELETE:       "CHANNEL_DELETE",
  PING:                 "PING",
  INTERACTION_CREATE:   "INTERACTION_CREATE",
} as const;

// ─── Ed25519 signature verification ──────────────────────────────────────────

/**
 * Verify a Discord request signature using Ed25519.
 * Returns true only if the signature is valid.
 * Must be called before processing any event payload.
 */
export async function verifyDiscordSignature(
  request: Request,
  body: string,
  publicKey: string
): Promise<boolean> {
  const signature  = request.headers.get("X-Signature-Ed25519");
  const timestamp  = request.headers.get("X-Signature-Timestamp");

  if (!signature || !timestamp) return false;

  try {
    const encoder = new TextEncoder();
    const keyBytes = hexToUint8Array(publicKey);
    const sigBytes = hexToUint8Array(signature);
    const msgBytes = encoder.encode(timestamp + body);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify("NODE-ED25519", cryptoKey, sigBytes, msgBytes);
  } catch {
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ─── Main event dispatcher ────────────────────────────────────────────────────

/**
 * Handle an inbound Discord Gateway event.
 * Called from index.ts at POST /gateway/event.
 *
 * Returns an appropriate HTTP Response.
 */
export async function handleGatewayEvent(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.text();

  // ── Signature verification (only when public key is configured) ────────────
  const publicKey = env.DISCORD_PUBLIC_KEY;
  if (publicKey) {
    const valid = await verifyDiscordSignature(request, body, publicKey);
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  let payload: { t?: string; op?: number; d?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = payload.t;
  const opcode    = payload.op;

  // Discord PING (op 1 or type PING) → respond with PONG
  if (opcode === 1 || eventType === DISCORD_EVENTS.PING) {
    return Response.json({ type: 1 }); // PONG
  }

  // Dispatch based on event type
  try {
    switch (eventType) {
      case DISCORD_EVENTS.MESSAGE_REACTION_ADD:
        await onReactionAdd(env, payload.d as RawReactionEvent);
        break;

      case DISCORD_EVENTS.MESSAGE_CREATE:
        await onMessageCreate(env, payload.d as RawMessageEvent);
        break;

      case DISCORD_EVENTS.CHANNEL_CREATE:
        await onChannelCreate(env, payload.d as RawChannelEvent);
        break;

      case DISCORD_EVENTS.CHANNEL_UPDATE:
        await onChannelUpdate(env, payload.d as RawChannelEvent);
        break;

      case DISCORD_EVENTS.CHANNEL_DELETE:
        await onChannelDelete(env, payload.d as RawChannelEvent);
        break;

      default:
        // Unknown / unhandled event – acknowledge silently
        break;
    }
  } catch (err) {
    // Log but never crash – always return 200 to Discord
    await insertMplusLog(env, "error", "API_ERROR",
      `Gateway event handler error (${eventType ?? "unknown"}): ${String(err)}`
    ).catch(() => {});
  }

  return new Response("OK", { status: 200 });
}

// ─── Raw Discord event types ──────────────────────────────────────────────────

interface RawReactionEvent {
  user_id?: string;
  channel_id?: string;
  message_id?: string;
  guild_id?: string;
  emoji?: { id?: string | null; name?: string };
  member?: { user?: { id: string; username: string } };
}

interface RawMessageEvent {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  author?: { id: string; username: string };
  content?: string;
  mentions?: { id: string; username: string }[];
  timestamp?: string;
}

interface RawChannelEvent {
  id?: string;
  type?: number;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function onReactionAdd(env: Env, d: RawReactionEvent): Promise<void> {
  if (!d.user_id || !d.channel_id || !d.message_id || !d.emoji?.name) return;

  const cfgRow = await getMonitoringConfig(env);
  const config = rowToConfig(cfgRow);
  if (!config.enabled) return;

  const event: DiscordReactionEvent = {
    user_id:    d.user_id,
    channel_id: d.channel_id,
    message_id: d.message_id,
    guild_id:   d.guild_id,
    emoji:      { id: d.emoji.id ?? null, name: d.emoji.name },
    member:     d.member,
  };

  await handleReactionAdd(env, event, config);
}

async function onMessageCreate(env: Env, d: RawMessageEvent): Promise<void> {
  if (!d.id || !d.channel_id || !d.author || !d.content) return;

  const cfgRow = await getMonitoringConfig(env);
  const config = rowToConfig(cfgRow);
  if (!config.enabled) return;

  const event: DiscordMessageEvent = {
    id:         d.id,
    channel_id: d.channel_id,
    guild_id:   d.guild_id,
    author:     d.author,
    content:    d.content,
    mentions:   d.mentions ?? [],
    timestamp:  d.timestamp ?? new Date().toISOString(),
  };

  await handleMessageCreate(env, event, config);
}

async function onChannelCreate(env: Env, d: RawChannelEvent): Promise<void> {
  if (!d.id || !d.guild_id) return;

  // Only handle text channels (type 0) and categories (type 4)
  // Skip DM channels, voice channels, etc.
  if (d.type !== 0 && d.type !== 4) return;

  const cfgRow = await getMonitoringConfig(env);
  const config = rowToConfig(cfgRow);

  // Resolve guild name
  const guild = await fetchGuild(env, d.guild_id);
  const guildName = guild?.name ?? d.guild_id;

  // Resolve category name if parent_id is set
  let categoryName: string | null = null;
  if (d.parent_id) {
    const parentCh = await fetchChannel(env, d.parent_id);
    categoryName = parentCh?.name ?? null;
  }

  await handleChannelCreate(
    env,
    d.id,
    d.name ?? d.id,
    d.guild_id,
    guildName,
    d.parent_id ?? null,
    categoryName,
    d.type ?? 0,
    config
  );
}

async function onChannelUpdate(env: Env, d: RawChannelEvent): Promise<void> {
  if (!d.id || !d.guild_id) return;
  if (d.type !== 0 && d.type !== 4) return;

  const cfgRow = await getMonitoringConfig(env);
  const config = rowToConfig(cfgRow);

  const guild = await fetchGuild(env, d.guild_id);
  const guildName = guild?.name ?? d.guild_id;

  let categoryName: string | null = null;
  if (d.parent_id) {
    const parentCh = await fetchChannel(env, d.parent_id);
    categoryName = parentCh?.name ?? null;
  }

  await handleChannelUpdate(
    env,
    d.id,
    d.name ?? d.id,
    d.guild_id,
    guildName,
    d.parent_id ?? null,
    categoryName,
    d.type ?? 0,
    config
  );
}

async function onChannelDelete(env: Env, d: RawChannelEvent): Promise<void> {
  if (!d.id) return;

  const cfgRow = await getMonitoringConfig(env);
  const config = rowToConfig(cfgRow);

  await handleChannelDelete(env, d.id, config);
}
