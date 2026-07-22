// src/lib/integrations/botConfirm.ts
// The confirm-yes gate for the staff text-ops bot (Phase 2 of the 2026-07-19
// plan). Every sensitive write echoes a one-line summary and does nothing until
// the sender replies "yes", so a misread text — or a wrong LLM interpretation —
// is harmless right up to the confirmation.
//
// Why this lives in the DB and not in memory: the webhook runs on stateless
// lambdas, so the message that stages the action and the message that confirms
// it are two different processes with nothing shared between them.
//
// Double-"yes" safety: the pending row is claimed ATOMICALLY (set consumed_at
// WHERE consumed_at is null). Two confirmations racing means exactly one wins
// the claim and the other sees nothing pending, so the write runs once.

import { getSupabaseServiceClient } from '@/lib/supabase';

export type PendingAction = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
};

const DEFAULT_TTL_SECONDS = 10 * 60;

// Deliberately tight lists. Anything else is treated as neither a yes nor a no,
// so the bot re-asks instead of guessing — the whole point of the gate is that
// ambiguity never executes a write.
const AFFIRMATIVE = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'confirm', 'confirmed', 'ok', 'okay', 'do it', 'go']);
const NEGATIVE = new Set(['no', 'n', 'nope', 'cancel', 'stop', 'nevermind', 'never mind', 'abort']);

const normalize = (text: string): string =>
  (text ?? '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.has(normalize(text));
}

export function isNegative(text: string): boolean {
  return NEGATIVE.has(normalize(text));
}

/**
 * Stage an action awaiting confirmation, returning its id (null when Supabase
 * isn't configured or the insert fails — the caller must then NOT tell the user
 * the action is pending).
 *
 * Supersedes this sender's other open actions first: staging B while A is still
 * pending must not leave A alive, or a later "yes" would fire whichever row a
 * query happened to return. One sender has at most one pending action.
 */
export async function stagePendingAction(opts: {
  chatId: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  ttlSeconds?: number;
}): Promise<string | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  await supersedeOpenActions(opts.chatId, opts.userId);

  const expiresAt = new Date(Date.now() + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000).toISOString();
  const { data, error } = await db
    .from('bot_pending_actions')
    .insert({
      chat_id: opts.chatId,
      user_id: opts.userId,
      tool: opts.tool,
      args: opts.args,
      summary: opts.summary,
      expires_at: expiresAt,
    })
    .select('id')
    .maybeSingle();

  if (error || !data) {
    console.error('[botConfirm] failed to stage pending action:', error);
    return null;
  }
  return (data as { id: string }).id;
}

/** Close this sender's open actions without running them. */
export async function supersedeOpenActions(chatId: string, userId: string): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  const { error } = await db
    .from('bot_pending_actions')
    .update({ consumed_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('consumed_at', null);
  if (error) console.error('[botConfirm] failed to supersede open actions:', error);
}

/**
 * Claim this sender's pending action so it can be executed exactly once.
 * Returns null when there is nothing pending, it already expired, or another
 * confirmation won the claim first.
 */
export async function consumePendingAction(
  chatId: string,
  userId: string,
): Promise<PendingAction | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from('bot_pending_actions')
    .select('id, tool, args, summary')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { id: string; tool: string; args: Record<string, unknown> | null; summary: string };

  // Atomic claim — the row is only ours if we are the writer that flipped
  // consumed_at from null. A racing "yes" gets zero rows back and returns null.
  const { data: claimed } = await db
    .from('bot_pending_actions')
    .update({ consumed_at: nowIso })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();

  if (!claimed) return null;
  return { id: row.id, tool: row.tool, args: row.args ?? {}, summary: row.summary };
}
