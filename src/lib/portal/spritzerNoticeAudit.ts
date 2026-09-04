// Who hid a customer's free-spritzer thank you, when, and what it said at the
// time (Naldo, 2026-09-03: "let's create a record for it to log it correctly").
//
// The switch itself is one boolean on the quote, which tells you the CURRENT
// state and nothing about how it got there. That is the same gap the inbox's
// suppressed-sender list had, and this follows the pattern that closed it
// (src/lib/dashboard/inbox/suppressionAudit.ts): every change writes a
// dashboard_activity row, and the panel that offers the switch reads the
// history back so the record is visible rather than write-only.
//
// What is deliberately captured beyond who and when: the COUNT the customer was
// being shown at the moment it was hidden. A month later, "Jason hid this on
// 3 September" is much less useful than "Jason hid a promise of 6 spritzers on
// 3 September", because the labels may have been edited since.
//
// dashboard_activity has no quote column (actor, action, inbox_item_id,
// contact_id, detail, created_at), so the quote is identified inside `detail`.

import { getSupabaseServiceClient } from '@/lib/supabase';

export const NOTICE_HIDDEN_ACTION = 'spritzer_notice_hidden';
export const NOTICE_SHOWN_ACTION = 'spritzer_notice_shown';

export type SpritzerNoticeAuditEntry = {
  /** True when this row hid the notice, false when it put it back. */
  hidden: boolean;
  /** Operator email, or 'system' when no operator resolved. */
  actor: string;
  /** ISO timestamp. */
  at: string;
  /** The count the customer was being shown when the change was made; null
   *  when the labels promised spritzers without a readable number. */
  count: number | null;
};

type ActivityRow = {
  actor: string | null;
  action: string;
  detail: { quoteId?: string; quoteNumber?: number | null; count?: number | null } | null;
  created_at: string;
};

/**
 * Record one change. Best-effort and never throws, matching the sibling audit:
 * the toggle it describes has already succeeded by the time this runs, and a
 * failed audit write must not turn a completed change into a 500.
 *
 * Returns whether the row actually landed, so the caller can TELL the operator
 * rather than quietly implying a record exists. A returned field nothing reads
 * is how this repo has shipped false reassurance before.
 */
export async function recordSpritzerNoticeChange(args: {
  quoteId: string;
  quoteNumber: number | null;
  hidden: boolean;
  count: number | null;
  actor: string | null;
}): Promise<boolean> {
  const sb = getSupabaseServiceClient();
  if (!sb) return false;
  const row = {
    // 'system' is the established stand-in for "no operator resolved" across
    // this table.
    actor: args.actor ?? 'system',
    action: args.hidden ? NOTICE_HIDDEN_ACTION : NOTICE_SHOWN_ACTION,
    detail: {
      quoteId: args.quoteId,
      quoteNumber: args.quoteNumber,
      count: args.count,
    },
  };
  try {
    const { error } = await sb.from('dashboard_activity').insert(row);
    if (error) {
      console.warn('[spritzerNoticeAudit] activity write failed (non-fatal):', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      '[spritzerNoticeAudit] activity write threw (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * This quote's change history, newest first. Best-effort: a quote changed
 * before this audit existed simply has no rows, and the panel says so rather
 * than pretending the switch has never been touched.
 *
 * Filters in SQL on the detail->>quoteId key rather than reading the table and
 * filtering in memory — dashboard_activity carries well over a thousand rows.
 */
export async function readSpritzerNoticeHistory(quoteId: string): Promise<SpritzerNoticeAuditEntry[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('dashboard_activity')
      .select('actor, action, detail, created_at')
      .in('action', [NOTICE_HIDDEN_ACTION, NOTICE_SHOWN_ACTION])
      .eq('detail->>quoteId', quoteId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      console.warn('[spritzerNoticeAudit] history read failed (non-fatal):', error.message);
      return [];
    }
    return ((data ?? []) as ActivityRow[]).map((r) => ({
      hidden: r.action === NOTICE_HIDDEN_ACTION,
      actor: r.actor ?? 'system',
      at: r.created_at,
      count: typeof r.detail?.count === 'number' ? r.detail.count : null,
    }));
  } catch (err) {
    console.warn(
      '[spritzerNoticeAudit] history read threw (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
