// src/app/api/integrations/telegram/webhook/route.ts
// Telegram Bot API webhook for the inventory bot (#82 Phase 3 alt channel).
//   POST — inbound message update from Telegram. Verifies the
//   X-Telegram-Bot-Api-Secret-Token header → checks the chat-id allowlist →
//   strips Telegram conventions (/ prefix, @bot mentions) → dispatches to the
//   shared command parser. Reply sent via sendMessage.
//
// Always 200s except on a bad secret (401), so Telegram doesn't retry endlessly.
// DORMANT until TELEGRAM_BOT_ENABLED='true' AND TELEGRAM_BOT_TOKEN is set.
// Public path (Telegram calls it, no operator auth) — see operatorGate.ts.

import { NextRequest, NextResponse } from 'next/server';
import {
  isTelegramBotEnabled,
  isTelegramConfigured,
  verifyTelegramSecret,
  isAllowedChat,
  sendTelegramMessage,
  cleanTelegramCommand,
} from '@/lib/integrations/telegram';
import { handleWhatsAppText } from '@/lib/integrations/whatsapp';

export const runtime = 'nodejs';

const ok = () => NextResponse.json({ ok: true });

export async function GET() {
  // For ops checks — Telegram itself doesn't GET; just return 200.
  return new NextResponse('OK', { status: 200 });
}

export async function POST(req: NextRequest) {
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) return ok();

  if (
    !verifyTelegramSecret(
      req.headers.get('x-telegram-bot-api-secret-token'),
      process.env.TELEGRAM_WEBHOOK_SECRET,
    )
  ) {
    return new NextResponse('Bad secret', { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return ok();
  }

  // Telegram Update shape we care about: message.chat.id + message.text. Status
  // updates (edited_message, callback_query, channel_post, etc.) are ignored.
  const update = body as {
    message?: { chat?: { id?: number | string }; text?: string };
  } | null;
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;
  if (!msg || typeof text !== 'string' || chatId === undefined) return ok();

  if (!isAllowedChat(chatId)) {
    console.warn('[telegram] ignored command from non-allowlisted chat:', chatId);
    return ok();
  }

  const command = cleanTelegramCommand(text);
  if (!command) return ok();

  try {
    // handleWhatsAppText is the provider-agnostic dispatcher (parse + run);
    // the name is legacy — both Twilio and Telegram routes call it.
    const reply = await handleWhatsAppText(command);
    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] command handling failed:', err);
    try {
      await sendTelegramMessage(chatId, 'Something went wrong handling that.');
    } catch {
      /* best-effort */
    }
  }
  return ok();
}
