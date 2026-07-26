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

// Field work sets this, not office work: a crew member stages a report, then
// climbs down, moves the truck, and talks to the homeowner before looking at
// their phone again. Ten minutes expired real confirmations; 45 is long enough
// to survive that without leaving a stale write pending all day.
const DEFAULT_TTL_SECONDS = 45 * 60;

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

export type StageResult = {
  id: string;
  /** A previous un-confirmed action was closed to make room for this one. */
  supersededSummary: string | null;
};

/**
 * Stage an action awaiting confirmation (null when Supabase isn't configured or
 * the insert fails — the caller must then NOT tell the user it is pending).
 *
 * Supersedes this sender's other open actions first: staging B while A is still
 * pending must not leave A alive, or a later "yes" would fire whichever row a
 * query happened to return. One sender has at most one pending action.
 *
 * The superseded summary comes back so the caller can SAY it happened. Silently
 * dropping the earlier report is how a crew member loses work: they text two
 * finished jobs in a row, confirm the second, and never learn the first was
 * discarded.
 */
export async function stagePendingAction(opts: {
  chatId: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  ttlSeconds?: number;
}): Promise<StageResult | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  const previous = await peekPendingAction(opts.chatId, opts.userId);

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

  // Supersede AFTER the insert succeeds, never before: closing the old action
  // first meant a failed insert left the sender with nothing pending, so their
  // next "yes" (meant for the earlier report) found nothing and the work had to
  // be retyped with no explanation. Excluding the row just created keeps the
  // one-pending-action-per-sender invariant intact.
  const newId = (data as { id: string }).id;
  await supersedeOpenActions(opts.chatId, opts.userId, newId);

  return { id: newId, supersededSummary: previous?.summary ?? null };
}

/**
 * Read this sender's open action WITHOUT consuming it. Used to answer "is
 * something still waiting?" — for a reply that is neither a clear yes nor a
 * clear no, and to decide whether a bare "yes" in a group chat is meant for us.
 */
export async function peekPendingAction(
  chatId: string,
  userId: string,
): Promise<PendingAction | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('bot_pending_actions')
    .select('id, tool, args, summary')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; tool: string; args: Record<string, unknown> | null; summary: string };
  return { id: row.id, tool: row.tool, args: row.args ?? {}, summary: row.summary };
}

/**
 * Add photo file ids to this sender's pending action.
 *
 * Telegram delivers an album as SEPARATE updates and puts the caption on only
 * one of them, so the later photos arrive with no text and would otherwise be
 * dropped while the reply still said "Saved 1 photo" — silent lost work.
 * Returns the pending action it appended to, or null if nothing was pending.
 */
export async function appendPhotosToPendingAction(
  chatId: string,
  userId: string,
  fileIds: string[],
): Promise<PendingAction | null> {
  const db = getSupabaseServiceClient();
  if (!db || !fileIds.length) return null;

  const pending = await peekPendingAction(chatId, userId);
  if (!pending) return null;

  const existing = Array.isArray(pending.args.photoFileIds)
    ? (pending.args.photoFileIds as string[])
    : [];
  const merged = [...new Set([...existing, ...fileIds])];
  const args = { ...pending.args, photoFileIds: merged };

  // Guarded on still-unconsumed: if the sender confirmed in the meantime, the
  // action already ran and quietly mutating its args would be a lie.
  const { data } = await db
    .from('bot_pending_actions')
    .update({ args })
    .eq('id', pending.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (!data) return null;

  return { ...pending, args };
}

/**
 * Close this sender's open actions without running them.
 * `exceptId` keeps a freshly staged row alive (see stagePendingAction).
 */
export async function supersedeOpenActions(
  chatId: string,
  userId: string,
  exceptId?: string,
): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  let q = db
    .from('bot_pending_actions')
    .update({ consumed_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('consumed_at', null);
  if (exceptId) q = q.neq('id', exceptId);
  const { error } = await q;
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
