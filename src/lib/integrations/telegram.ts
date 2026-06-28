// src/lib/integrations/telegram.ts
// Inventory Telegram bot — second channel alongside the Twilio WhatsApp bot
// (#82 Phase 3). WhatsApp Business numbers can't be in group chats AT ALL
// (platform limit, not Twilio-specific); Telegram supports native group bots,
// so the staff "group chat with the bot" use case lives here.
//
// Reuses the provider-agnostic parser (whatsappCommands.ts) + dispatcher
// (handleWhatsAppText in whatsapp.ts — same plain-text-in, plain-text-out logic;
// the name is historical). This module only handles Telegram's wire format
// (Bot API HTTP + secret-token webhook verify + chat-id allowlist).
//
// DORMANT by default — webhook just 200s unless TELEGRAM_BOT_ENABLED='true' AND
// TELEGRAM_BOT_TOKEN is set.
//
// Env:
//   TELEGRAM_BOT_ENABLED      'true' to activate (master flag)
//   TELEGRAM_BOT_TOKEN        bot token from @BotFather (digits:alphanumerics)
//   TELEGRAM_WEBHOOK_SECRET   random string passed to setWebhook, verified on each request
//   TELEGRAM_ALLOWED_CHATS    comma-separated Telegram chat IDs (negative for groups)

import { safeEqual } from '@/lib/security';

const API_BASE = 'https://api.telegram.org';

export function isTelegramBotEnabled(): boolean {
  return process.env.TELEGRAM_BOT_ENABLED === 'true';
}
export function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

/**
 * Verify Telegram's X-Telegram-Bot-Api-Secret-Token header against the secret
 * we passed to setWebhook. Constant-time. Fails closed when the secret isn't
 * configured server-side (no secret ⇒ no access).
 */
export function verifyTelegramSecret(
  headerToken: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  if (!headerToken) return false;
  return safeEqual(headerToken, expected);
}

/**
 * True when `chatId` is in the env allowlist. Fails closed when unset.
 * Chat IDs are numeric — positive for 1:1 user chats, negative for groups
 * (and large-negative for supergroups). We accept either number or string
 * because Telegram sends numbers but env vars are strings.
 */
export function isAllowedChat(chatId: number | string | null | undefined): boolean {
  const allow = (process.env.TELEGRAM_ALLOWED_CHATS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return false;
  const norm = String(chatId ?? '').trim();
  return !!norm && allow.includes(norm);
}

/** Send a plain-text message to a Telegram chat. Throws on failure. */
export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot not configured');
  const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

/**
 * Strip Telegram conventions so the existing command parser sees plain text.
 * Handles:
 *   /help                       → help
 *   /help@yll_inventory_bot     → help
 *   @yll_inventory_bot jobs     → jobs
 *   jobs @yll_inventory_bot     → jobs
 *   move 1042 prepared          → move 1042 prepared   (unchanged)
 * Aggressively strips ANY @<token> mention since none of our commands use @
 * in their args.
 */
export function cleanTelegramCommand(text: string | null | undefined): string {
  let t = (text ?? '').trim();
  if (t.startsWith('/')) t = t.slice(1);
  // Remove @mention tokens anywhere in the message + collapse whitespace.
  t = t.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim();
  return t;
}
