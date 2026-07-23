// src/lib/integrations/botUsers.ts
// Data layer for the text-ops bot roster (Settings → Bot team, ledger #168).
// One row per Telegram USER id → role. The admin API routes (requireAdmin) call
// the write helpers; the bot's role resolution calls roleFromDb on each message.
//
// Reads swallow to a safe default (null / []) so a Supabase hiccup can never
// crash the bot or lock the room out — resolveSenderRole then falls back to the
// env floor. Writes throw (the admin UI surfaces the error).

import { getSupabaseServiceClient } from '@/lib/supabase';
import { roleForUser, higherRole, type BotRole } from './botRoles';

export type BotUser = {
  telegramUserId: string;
  displayName: string | null;
  role: BotRole;
  addedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const SELECT = 'telegram_user_id, display_name, role, added_by, created_at, updated_at';

type Row = {
  telegram_user_id: string;
  display_name: string | null;
  role: BotRole;
  added_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function toBotUser(r: Row): BotUser {
  return {
    telegramUserId: r.telegram_user_id,
    displayName: r.display_name,
    role: r.role,
    addedBy: r.added_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// A Telegram user id is all digits (message.from.id). Reject anything else up
// front so a fat-fingered entry can't create a row that never matches a sender.
export function isValidTelegramId(id: string): boolean {
  return /^\d{3,}$/.test(id.trim());
}

/** Every roster row, newest first. Returns [] when Supabase isn't configured. */
export async function listBotUsers(): Promise<BotUser[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('bot_users')
    .select(SELECT)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listBotUsers error:', error);
    return [];
  }
  return (data ?? []).map((r) => toBotUser(r as Row));
}

/** One roster row by Telegram user id, or null when absent. */
export async function getBotUser(telegramUserId: string): Promise<BotUser | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('bot_users')
    .select(SELECT)
    .eq('telegram_user_id', telegramUserId.trim())
    .maybeSingle();
  if (error || !data) return null;
  return toBotUser(data as Row);
}

/**
 * The role for one Telegram user id from the roster, or null when absent /
 * unavailable. Fail-closed to null on ANY error so the caller falls back to the
 * env floor rather than crashing the bot.
 */
export async function roleFromDb(userId: string | number | null | undefined): Promise<BotRole | null> {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  try {
    const db = getSupabaseServiceClient();
    if (!db) return null;
    const { data, error } = await db
      .from('bot_users')
      .select('role')
      .eq('telegram_user_id', id)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { role: BotRole }).role;
  } catch (err) {
    console.error('roleFromDb error:', err);
    return null;
  }
}

/**
 * The effective role for a message sender whose CHAT already passed the
 * allowlist. Combines the DB roster with the env floor and defaults an
 * unassigned-but-allowlisted sender to crew (same least-privilege default as the
 * env-only roleForSenderInAllowedChat it replaces in the dispatcher).
 *
 * Taking the HIGHER of DB and env means the roster can add anyone at any tier
 * and elevate an env member, but can never demote a bootstrap admin out of
 * access — an owner cannot lock themselves out by editing the roster.
 */
export async function resolveSenderRole(userId: string | number | null | undefined): Promise<BotRole> {
  const dbRole = await roleFromDb(userId);
  const envRole = roleForUser(userId);
  return higherRole(dbRole, envRole) ?? 'crew';
}

/** Add or update a roster entry (upsert by telegram_user_id). Throws on failure. */
export async function upsertBotUser(input: {
  telegramUserId: string;
  displayName?: string | null;
  role: BotRole;
  addedBy?: string | null;
}): Promise<BotUser> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const payload = {
    telegram_user_id: input.telegramUserId.trim(),
    display_name: input.displayName?.trim() || null,
    role: input.role,
    added_by: input.addedBy?.trim() || null,
  };
  const { data, error } = await db
    .from('bot_users')
    .upsert(payload, { onConflict: 'telegram_user_id' })
    .select(SELECT)
    .maybeSingle();
  if (error || !data) throw new Error(`upsertBotUser: ${error?.message ?? 'no row returned'}`);
  return toBotUser(data as Row);
}

/** Remove a roster entry. Returns false when the id wasn't present. */
export async function deleteBotUser(telegramUserId: string): Promise<boolean> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const { data, error } = await db
    .from('bot_users')
    .delete()
    .eq('telegram_user_id', telegramUserId.trim())
    .select('telegram_user_id');
  if (error) throw new Error(`deleteBotUser: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
