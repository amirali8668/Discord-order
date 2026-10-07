// ══════════════════════════════════════════════════════════════════════════════
// types.ts — Railway version
// Mirrors the Cloudflare types but adapted for Node.js + PostgreSQL.
// ══════════════════════════════════════════════════════════════════════════════

import type { Pool } from "pg";

// ─── Runtime environment ──────────────────────────────────────────────────────
export interface Env {
  DB:                Pool;       // PostgreSQL pool (replaces D1)
  DISCORD_TOKEN:     string;     // Main credential — ACTION operations
  DISCORD_READ_TOKEN?: string;   // Read credential — READ operations
  PANEL_PASSWORD:    string;
  SESSION_SECRET:    string;
  TELEGRAM_TOKEN?:   string;
  DISCORD_PUBLIC_KEY?: string;
  // KV is replaced by kv_store table in PostgreSQL
}

// ─── Credential purpose ───────────────────────────────────────────────────────
export type CredentialPurpose = "READ" | "ACTION";

// ─── Character types ──────────────────────────────────────────────────────────
export const CHARACTER_TYPES = ["nostack", "plate", "cloth", "mail", "leather"] as const;
export type CharacterType = typeof CHARACTER_TYPES[number];

// ─── Channel parser ───────────────────────────────────────────────────────────
export interface ParsedChannel {
  parsed:   true;
  type:     string;
  count:    number;
  level:    number;
  customer: string;
}
export interface UnparsedChannel { parsed: false; status: "UNPARSED"; }
export type ChannelParseResult = ParsedChannel | UnparsedChannel;

// ─── Bot config (original bot — stored in kv_store) ───────────────────────────
export interface BotConfig {
  channels:            string[];
  response_message:    string;
  gold_amount:         string;
  targets:             string[];
  inventory_message:   string;
  inventory_enabled:   boolean;
  keywords_all:        string[];
  keyword_single:      string;
  banned_keywords:     string[];
  poll_limit:          number;
  ping_interval_seconds: number;
}
export const DEFAULT_BOT_CONFIG: BotConfig = {
  channels: [], response_message: "salam khobi dash SPIN ALLY",
  gold_amount: "0", targets: [], inventory_message: "Hello, SPIN ALLY inventory notification",
  inventory_enabled: true, keywords_all: ["Spineshatter", "Alliance", "Mail"],
  keyword_single: "Spineshatter", banned_keywords: ["yeja"], poll_limit: 5,
  ping_interval_seconds: 60,
};

export interface AwaitingApproval { author_id: string; message_content: string; timestamp: number; }
export interface PendingTarget    { dm_channel_id: string; last_ping: number; active: boolean; }
export interface BotLog           { timestamp: number; level: "info"|"success"|"error"|"warn"; message: string; }

// ─── Discord API types ────────────────────────────────────────────────────────
export interface DiscordMessage {
  id: string; content: string;
  author: { id: string; username: string };
  reactions?: { count: number; emoji: { name: string } }[];
}
export interface DiscordChannel {
  id: string; type: number; guild_id?: string; name?: string; parent_id?: string | null;
}
export interface DiscordGuild { id: string; name: string; icon?: string | null; }
export interface DiscordReactionEvent {
  user_id: string; channel_id: string; message_id: string; guild_id?: string;
  emoji: { id?: string | null; name: string };
  member?: { user?: { id: string; username: string } };
}
export interface DiscordMessageEvent {
  id: string; channel_id: string; guild_id?: string;
  author: { id: string; username: string };
  content: string; mentions?: { id: string; username: string }[];
  timestamp: string;
}

// ─── DB row types ─────────────────────────────────────────────────────────────
export interface GuildRow {
  id: string; name: string; icon: string | null;
  monitoring: number; last_event_at: number | null;
  created_at: number; updated_at: number;
}
export interface CategoryRow {
  id: string; guild_id: string; name: string;
  monitoring: number; last_event_at: number | null;
  created_at: number; updated_at: number;
}
export interface ChannelRow {
  id: string; guild_id: string; guild_name: string;
  category_id: string | null; category_name: string | null;
  name: string; channel_type: number;
  parsed: number; boost_type: string | null; boost_count: number | null;
  boost_level: number | null; customer: string | null; parse_status: string;
  active: number; monitoring: number; in_level_range: number;
  last_event_at: number | null; created_at: number; updated_at: number;
}
export type MonitoringState = "INACTIVE" | "ACTIVE" | "PAUSED_FOR_CONFIRMATION";

export type BoostStatus = "ACTIVE"|"SENT"|"WAITING"|"ACCEPTED"|"IGNORED"|"EXPIRED"|"ERROR";
export interface BoostRow {
  id: string; guild_id: string; guild_name: string;
  category_id: string | null; category_name: string | null;
  channel_id: string; channel_name: string;
  customer: string; level: number; count: number; boost_type: string;
  fingerprint: string; outgoing_message_id: string | null;
  outgoing_message_content: string | null; status: BoostStatus;
  created_at: number; sent_at: number | null; accepted_at: number | null;
  acceptance_method: string | null; accepted_by_user_id: string | null;
  accepted_by_username: string | null; accepted_reaction: string | null;
  acceptance_message_id: string | null; notif_sent: number;
}
export type AcceptanceMode   = "ANY" | "ALL";
export type AcceptanceMethod = "REACTION" | "MENTION";
export interface AcceptanceRow {
  id: string; boost_id: string; outgoing_message_id: string;
  channel_id: string; method: AcceptanceMethod;
  accepted_by_user_id: string; accepted_by_username: string | null;
  reaction_emoji: string | null; mention_message_id: string | null;
  mention_content: string | null; accepted_at: number;
}
export interface MonitoringConfigRow {
  id: number; enabled: number; min_level: number; max_level: number;
  message_template: string; acceptance_mode: AcceptanceMode;
  accepted_reactions: string; mention_target_id: string | null;
  accept_reaction: number; accept_mention: number;
  any_reaction_accepted: number; paused_after_accept: number;
  paused: number; paused_for_confirmation: number;
  last_accepted_boost_id: string | null;
  notification_channel_id: string | null;
  discovery_interval_sec: number;
  sign_delay_sec: number;
  queue_delay_sec: number;
  updated_at: number;
}
export interface MonitoringConfig {
  enabled: boolean; minLevel: number; maxLevel: number;
  messageTemplate: string; acceptanceMode: AcceptanceMode;
  acceptedReactions: string[]; mentionTargetId: string | null;
  acceptReaction: boolean; acceptMention: boolean;
  anyReactionAccepted: boolean; pausedAfterAccept: boolean;
  paused: boolean; pausedForConfirmation: boolean;
  lastAcceptedBoostId: string | null;
  notificationChannelId: string | null;
  discoveryIntervalSec: number;
  signDelaySec: number;
  queueDelaySec: number;
}
export interface TelegramConfigRow {
  id: number; chat_id: string | null;
  alert_boost_accepted: number; alert_new_boost: number;
  alert_new_channel: number; alert_errors: number; updated_at: number;
}
export interface MplusLogRow {
  id: string; level: "info"|"success"|"warn"|"error";
  event_type: string; guild_id: string | null; channel_id: string | null;
  boost_id: string | null; message: string; context: string | null; created_at: number;
}
export interface GuildCharacterTypesRow {
  guild_id: string; enabled_types: string; allow_all: number; updated_at: number;
}
export interface GuildCharacterTypesConfig {
  guildId: string; allowAll: boolean; enabledTypes: CharacterType[];
}

// ─── TelegramConfig (deserialized) ────────────────────────────────────────────
export interface TelegramConfig {
  chatId: string | null;
  alertBoostAccepted: boolean;
  alertNewBoost: boolean;
  alertNewChannel: boolean;
  alertErrors: boolean;
}
export interface ResourceFailureRow {
  resource_key: string; failure_type: string; http_status: number;
  first_failed_at: number; last_failed_at: number; failure_count: number;
  cooldown_until: number; resolved_at: number | null;
}

// ─── Realtime events (WebSocket broadcast) ───────────────────────────────────
export type RealtimeEventType =
  | "CHANNEL_CREATED" | "CHANNEL_UPDATED" | "CHANNEL_DELETED"
  | "BOOST_FOUND" | "BOOST_WAITING" | "BOOST_ACCEPTED" | "BOOST_INACTIVE"
  | "MONITORING_CHANGED" | "ERROR" | "PING";
export interface RealtimeEvent {
  type: RealtimeEventType; payload: unknown; timestamp: number;
}

// ─── Log event types ──────────────────────────────────────────────────────────
export type LogEventType =
  | "CONFIG_CHANGED" | "GUILD_DISCOVERED" | "CATEGORY_DISCOVERED"
  | "CHANNEL_DISCOVERED" | "CHANNEL_CREATE" | "CHANNEL_UPDATE" | "CHANNEL_DELETE"
  | "PARSER_FAILURE" | "BOOST_FOUND" | "BOOST_IGNORED" | "BOOST_LOCK_REJECTED"
  | "MESSAGE_SENT" | "MESSAGE_SEND_FAILED" | "ACCEPTANCE_DETECTED"
  | "ACCEPTANCE_DUPLICATE" | "GATEWAY_DISCONNECT" | "GATEWAY_RECONNECT"
  | "TELEGRAM_SUCCESS" | "TELEGRAM_FAILURE" | "API_ERROR" | "SYSTEM";
