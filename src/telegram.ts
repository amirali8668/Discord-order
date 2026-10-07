/**
 * telegram.ts – Telegram alert-only notification service.
 *
 * Rules:
 *   - Alerts are fire-and-forget.
 *   - A Telegram failure NEVER rolls back Discord operations.
 *   - A Telegram failure NEVER changes boost state.
 *   - Tokens/secrets are NEVER included in alerts.
 */

import type { Env, TelegramConfig } from "./types.js";
import {
  getTelegramConfig,
  getBoost,
  getAcceptancesForBoost,
  insertMplusLog,
} from "./db.js";

const TG_API = "https://api.telegram.org";

// ─── Core send ────────────────────────────────────────────────────────────────

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`[telegram] sendMessage failed: ${resp.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[telegram] sendMessage exception: ${String(err)}`);
    return false;
  }
}

async function getTokenAndConfig(env: Env): Promise<{ token: string; cfg: TelegramConfig } | null> {
  const token = env.TELEGRAM_TOKEN;
  if (!token) return null;

  const row = await getTelegramConfig(env);
  if (!row.chat_id) return null;

  return {
    token,
    cfg: {
      chatId: row.chat_id,
      alertBoostAccepted: !!row.alert_boost_accepted,
      alertNewBoost: !!row.alert_new_boost,
      alertNewChannel: !!row.alert_new_channel,
      alertErrors: !!row.alert_errors,
    },
  };
}

function esc(s: string): string {
  // Escape HTML entities for Telegram HTML mode
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ─── Alert: Boost Accepted ────────────────────────────────────────────────────

export async function sendTelegramBoostAccepted(env: Env, boostId: string): Promise<void> {
  const ctx = await getTokenAndConfig(env);
  if (!ctx || !ctx.cfg.alertBoostAccepted) return;

  const boost = await getBoost(env, boostId);
  if (!boost) return;

  const acceptances = await getAcceptancesForBoost(env, boostId);
  const acc = acceptances[acceptances.length - 1];

  const text = [
    `<b>✅ Boost Accepted</b>`,
    ``,
    `<b>Boost ID:</b>  <code>${esc(boost.id)}</code>`,
    `<b>Server:</b>    ${esc(boost.guild_name)}`,
    `<b>Guild ID:</b>  <code>${esc(boost.guild_id)}</code>`,
    `<b>Category:</b>  ${esc(boost.category_name ?? "—")}`,
    `<b>Channel:</b>   #${esc(boost.channel_name)}`,
    `<b>Channel ID:</b> <code>${esc(boost.channel_id)}</code>`,
    ``,
    `<b>Customer:</b>  ${esc(boost.customer)}`,
    `<b>Level:</b>     +${boost.level}`,
    `<b>Count:</b>     ${boost.count}`,
    `<b>Type:</b>      ${esc(boost.boost_type)}`,
    ``,
    `<b>Outgoing message:</b>`,
    `<code>${esc(boost.outgoing_message_content ?? "—")}</code>`,
    ``,
    `<b>Accepted by:</b>  ${esc(boost.accepted_by_username ?? boost.accepted_by_user_id ?? "—")}`,
    `<b>Method:</b>    ${esc(boost.acceptance_method ?? "—")}`,
    acc?.reaction_emoji ? `<b>Reaction:</b>   ${esc(acc.reaction_emoji)}` : null,
    acc?.mention_content ? `<b>Mention:</b>    ${esc(acc.mention_content.slice(0, 100))}` : null,
    ``,
    `<b>Timestamp:</b> ${ts(boost.accepted_at ?? Date.now())}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const ok = await sendTelegramMessage(ctx.token, ctx.cfg.chatId!, text);
  if (ok) {
    await insertMplusLog(env, "info", "TELEGRAM_SUCCESS",
      `Telegram boost-accepted alert sent for boost ${boostId}`, { boostId });
  } else {
    await insertMplusLog(env, "error", "TELEGRAM_FAILURE",
      `Telegram boost-accepted alert failed for boost ${boostId}`, { boostId });
  }
}

// ─── Alert: New Matching Boost ────────────────────────────────────────────────

export async function sendTelegramNewBoost(
  env: Env,
  boostId: string,
  channelName: string,
  guildName: string,
  guildId: string,
  categoryName: string | null,
  customer: string,
  level: number,
  count: number,
  type: string,
  content: string
): Promise<void> {
  const ctx = await getTokenAndConfig(env);
  if (!ctx || !ctx.cfg.alertNewBoost) return;

  const text = [
    `<b>🎯 New Matching Boost</b>`,
    ``,
    `<b>Boost ID:</b>   <code>${esc(boostId)}</code>`,
    `<b>Server:</b>     ${esc(guildName)}`,
    `<b>Guild ID:</b>   <code>${esc(guildId)}</code>`,
    `<b>Category:</b>   ${esc(categoryName ?? "—")}`,
    `<b>Channel:</b>    #${esc(channelName)}`,
    ``,
    `<b>Customer:</b>   ${esc(customer)}`,
    `<b>Level:</b>      +${level}`,
    `<b>Count:</b>      ${count}`,
    `<b>Type:</b>       ${esc(type)}`,
    ``,
    `<b>Message sent:</b>`,
    `<code>${esc(content)}</code>`,
    ``,
    `<b>Timestamp:</b>  ${ts(Date.now())}`,
  ].join("\n");

  const ok = await sendTelegramMessage(ctx.token, ctx.cfg.chatId!, text);
  await insertMplusLog(env, ok ? "info" : "error",
    ok ? "TELEGRAM_SUCCESS" : "TELEGRAM_FAILURE",
    `Telegram new-boost alert ${ok ? "sent" : "failed"} for boost ${boostId}`,
    { boostId });
}

// ─── Alert: New Channel ───────────────────────────────────────────────────────

export async function sendTelegramNewChannel(
  env: Env,
  channelId: string,
  channelName: string,
  guildName: string,
  guildId: string,
  categoryName: string | null,
  categoryId: string | null,
  parsedInfo: string
): Promise<void> {
  const ctx = await getTokenAndConfig(env);
  if (!ctx || !ctx.cfg.alertNewChannel) return;

  const text = [
    `<b>📢 New Channel Detected</b>`,
    ``,
    `<b>Server:</b>     ${esc(guildName)}`,
    `<b>Guild ID:</b>   <code>${esc(guildId)}</code>`,
    `<b>Category:</b>   ${esc(categoryName ?? "—")}`,
    `<b>Category ID:</b> <code>${esc(categoryId ?? "—")}</code>`,
    `<b>Channel:</b>    #${esc(channelName)}`,
    `<b>Channel ID:</b> <code>${esc(channelId)}</code>`,
    `<b>Parsed:</b>     ${esc(parsedInfo)}`,
    `<b>Timestamp:</b>  ${ts(Date.now())}`,
  ].join("\n");

  const ok = await sendTelegramMessage(ctx.token, ctx.cfg.chatId!, text);
  await insertMplusLog(env, ok ? "info" : "error",
    ok ? "TELEGRAM_SUCCESS" : "TELEGRAM_FAILURE",
    `Telegram new-channel alert ${ok ? "sent" : "failed"} for channel ${channelId}`,
    { channelId, guildId });
}

// ─── Alert: Error ─────────────────────────────────────────────────────────────

export async function sendTelegramError(
  env: Env,
  component: string,
  errorType: string,
  message: string,
  context?: { guildId?: string; channelId?: string }
): Promise<void> {
  const ctx = await getTokenAndConfig(env);
  if (!ctx || !ctx.cfg.alertErrors) return;

  const text = [
    `<b>❌ System Error</b>`,
    ``,
    `<b>Component:</b>  ${esc(component)}`,
    `<b>Type:</b>       ${esc(errorType)}`,
    `<b>Message:</b>    ${esc(message.slice(0, 300))}`,
    context?.guildId   ? `<b>Guild:</b>      <code>${esc(context.guildId)}</code>` : null,
    context?.channelId ? `<b>Channel:</b>    <code>${esc(context.channelId)}</code>` : null,
    `<b>Timestamp:</b>  ${ts(Date.now())}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  // Errors: attempt once, do not throw
  await sendTelegramMessage(ctx.token, ctx.cfg.chatId!, text).catch(() => {});
}

// ─── Test alert ───────────────────────────────────────────────────────────────

export async function sendTelegramTest(
  token: string,
  chatId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ok = await sendTelegramMessage(
      token,
      chatId,
      `<b>🤖 Discord Bot Panel</b>\n\nTelegram connection test successful.\n${ts(Date.now())}`
    );
    return ok ? { ok: true } : { ok: false, error: "Telegram API returned failure" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
