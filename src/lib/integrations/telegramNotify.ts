// src/lib/integrations/telegramNotify.ts
// Shared bits for the proactive Telegram pings. The old blanket broadcaster
// (notifyTelegram) that sent every ping to every chat in TELEGRAM_ALLOWED_CHATS
// was replaced by the per-audience router — see telegramRouting.ts
// (notifyTelegramAudience) — which keeps the same dormancy-aware, fail-open
// semantics but routes each notification kind to the chats staff assigned in
// Settings → Telegram.

/** Absolute base for tappable links in pings (crons/libs have no req context). */
export function appBaseUrl(): string {
  return (process.env.PORTAL_BASE_URL || 'https://quote.yulelovelights.com').replace(/\/+$/, '');
}
