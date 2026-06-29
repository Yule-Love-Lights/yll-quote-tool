// src/lib/integrations/telegramNotify.ts
// Best-effort OUTBOUND broadcaster for the proactive inventory pings (#82
// follow-up). Sends a message to every chat in TELEGRAM_ALLOWED_CHATS — the same
// group(s) the command bot already serves. DORMANCY-aware (no-op unless the bot is
// enabled + configured) and FAIL-OPEN: a Telegram outage never propagates to the
// caller — job creation, the low-stock cron, and the supplier PO email must not
// break on a ping failure.

import {
  isTelegramBotEnabled,
  isTelegramConfigured,
  allowedChats,
  sendTelegramMessage,
} from './telegram';

/** Absolute base for tappable links in pings (crons/libs have no req context). */
export function appBaseUrl(): string {
  return (process.env.PORTAL_BASE_URL || 'https://quote.yulelovelights.com').replace(/\/+$/, '');
}

type Sender = (chatId: number | string, text: string) => Promise<void>;

/**
 * Broadcast `text` to every allowlisted chat. No-op when the bot is dormant or the
 * allowlist is empty. Each send is isolated — one failure is logged and the rest
 * still go out; this never throws. `send` is injectable for tests.
 */
export async function notifyTelegram(text: string, send: Sender = sendTelegramMessage): Promise<void> {
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) return;
  const chats = allowedChats();
  if (!chats.length) return;
  for (const chat of chats) {
    try {
      await send(chat, text);
    } catch (err) {
      console.error('[telegramNotify] send failed for chat', chat, err);
    }
  }
}
