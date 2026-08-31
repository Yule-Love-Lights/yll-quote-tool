// src/lib/integrations/telegramRouting.ts
// Per-audience Telegram chat routing. Outbound notifications historically
// broadcast to EVERY chat in TELEGRAM_ALLOWED_CHATS (telegramNotify.ts), which
// meant the Jobs and Inventory group chats also received new-lead pings. This
// module routes each notification KIND (an "audience") to only the chats staff
// assigned in Settings → Telegram, stored as one app_settings row (no migration,
// mirroring low_stock_notify_last).
//
// Fallback semantics (back-compat): while NO routing row is stored, every
// audience broadcasts to the full env allowlist — legacy behavior, nothing
// changes until staff save a routing config. Once a row EXISTS it is
// authoritative: an audience with no chats assigned sends NOTHING (the Settings
// UI surfaces this). Assigned chats are always intersected with the env
// allowlist, so a stale DB row can never make the bot message a chat outside
// TELEGRAM_ALLOWED_CHATS.

import { getSupabaseServiceClient } from '../supabase';
import {
  allowedChats,
  isTelegramBotEnabled,
  isTelegramConfigured,
  sendTelegramMessage,
} from './telegram';

// 'crew' is deliberately SEPARATE from 'jobs': the jobs audience also carries
// installment-run summaries, which are customer charge totals, and the crew
// schedule message goes to a chat full of field crew. Keeping them apart means
// routing the crew chat can never put money in front of the crew by accident
// (staff lens, PR #1129).
export const TELEGRAM_AUDIENCES = ['leads', 'jobs', 'inventory', 'ops', 'crew'] as const;
export type TelegramAudience = (typeof TELEGRAM_AUDIENCES)[number];

export const TELEGRAM_AUDIENCE_LABELS: Record<TelegramAudience, string> = {
  leads: 'Leads',
  jobs: 'Jobs',
  inventory: 'Inventory',
  ops: 'Ops digest',
  crew: 'Crew schedule',
};

export const TELEGRAM_ROUTING_KEY = 'telegram_chat_routing';

/** audience → chat-id strings (subset of TELEGRAM_ALLOWED_CHATS). */
export type TelegramRouting = Record<TelegramAudience, string[]>;

/**
 * Narrow an unknown stored/posted value to a complete TelegramRouting, or null
 * when it isn't one (caller treats null as "no routing configured"). Unknown
 * keys are dropped; missing audiences become empty lists; chat ids are trimmed
 * non-empty strings, deduped, in order.
 */
export function sanitizeTelegramRouting(v: unknown): TelegramRouting | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const out = {} as TelegramRouting;
  for (const audience of TELEGRAM_AUDIENCES) {
    const raw = r[audience];
    const ids: string[] = [];
    if (Array.isArray(raw)) {
      const seen = new Set<string>();
      for (const c of raw) {
        const norm = typeof c === 'string' ? c.trim() : '';
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          ids.push(norm);
        }
      }
    }
    out[audience] = ids;
  }
  return out;
}

/** Read the stored routing, or null when none has been saved (legacy broadcast). */
export async function getTelegramRouting(): Promise<TelegramRouting | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('app_settings')
    .select('value')
    .eq('key', TELEGRAM_ROUTING_KEY)
    .maybeSingle();
  if (error) {
    console.error('[telegramRouting] read failed:', error.message);
    return null;
  }
  return sanitizeTelegramRouting((data as { value?: unknown } | null)?.value);
}

/** Upsert the routing row (sanitized). Throws on write failure. */
export async function putTelegramRouting(routing: unknown): Promise<TelegramRouting> {
  const clean = sanitizeTelegramRouting(routing);
  if (!clean) throw new Error('invalid telegram routing');
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('database not configured');
  const { error } = await db
    .from('app_settings')
    .upsert({ key: TELEGRAM_ROUTING_KEY, value: clean }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return clean;
}

/**
 * Pure: the chats an audience's message goes to. No routing stored → the full
 * allowlist (legacy broadcast). Routing stored → the audience's assigned chats
 * intersected with the allowlist (empty ⇒ send nothing).
 */
export function chatsForAudience(
  audience: TelegramAudience,
  routing: TelegramRouting | null,
  allow: string[],
): string[] {
  if (!routing) return allow;
  const allowSet = new Set(allow);
  return routing[audience].filter((c) => allowSet.has(c));
}

type Sender = (chatId: number | string, text: string) => Promise<void>;

/**
 * Send `text` to the chats routed for `audience`. Same contract as the legacy
 * notifyTelegram broadcast: no-op when the bot is dormant/unconfigured, each
 * send isolated, NEVER throws (a Telegram outage must not break job creation,
 * lead capture, or a cron). `send` is injectable for tests.
 */
export async function notifyTelegramAudience(
  audience: TelegramAudience,
  text: string,
  send: Sender = sendTelegramMessage,
): Promise<void> {
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) return;
  const allow = allowedChats();
  if (!allow.length) return;
  let routing: TelegramRouting | null = null;
  try {
    routing = await getTelegramRouting();
  } catch (err) {
    console.error('[telegramRouting] falling back to broadcast:', err);
  }
  const chats = chatsForAudience(audience, routing, allow);
  for (const chat of chats) {
    try {
      await send(chat, text);
    } catch (err) {
      console.error('[telegramRouting] send failed for chat', chat, err);
    }
  }
}
