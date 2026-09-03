// Who was silenced, when, and by what (S75, Naldo 2026-08-29).
//
// `dashboard.suppressedSenders` is a bare string[]: it says an address is
// silenced and nothing else. That was fine while the list was small, and is not
// fine now. Measured on prod the day this shipped: 152 suppressed senders, of
// which 10 have a quote in the tool and 5 are BOOKED customers. Their emails
// classify as 'automated' and stop notifying staff, and until now there was no
// screen anywhere that would show you that.
//
// Naldo's ask, verbatim: "we should track and see who is marked as that just in
// case we make a mistake if we need to revert anything."
//
// So: every add and every remove writes a dashboard_activity row, and the
// settings panel reads the live list back with whatever history exists for each
// entry. The list itself keeps its exact string[] shape — every reader
// (normalizeGmailThread, normalizeGhlConversation, the sync) goes on working
// untouched, and the audit is additive.

import { getSupabaseServiceClient } from '@/lib/supabase';

export const SUPPRESSED_ACTION = 'sender_suppressed';
export const UNSUPPRESSED_ACTION = 'sender_unsuppressed';

export type SuppressionContext = {
  /** The operator who did it, or null when the auth gate is dormant. */
  actor?: string | null;
  /** The inbox item the click came from, when there was one. */
  inboxItemId?: string | null;
  /** The contact the identifiers were read off, when there was one. */
  contactId?: string | null;
  /** Free text for a caller that wants to say why (e.g. 'reversed a dismiss'). */
  note?: string | null;
};

/**
 * Record one activity row per identifier. Best-effort and never throws: an
 * audit-write failure must not fail the dismiss that triggered it, exactly like
 * the suppression write itself. The caller passes ALREADY-NORMALIZED values so
 * what lands here matches what is actually in the list.
 */
export async function recordSuppressionChange(
  action: typeof SUPPRESSED_ACTION | typeof UNSUPPRESSED_ACTION,
  values: string[],
  ctx: SuppressionContext = {},
): Promise<void> {
  if (!values.length) return;
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const rows = values.map((value) => ({
    // dashboard_activity.actor is text, and 'system' is the established
    // stand-in for "no operator resolved" across this table.
    actor: ctx.actor ?? 'system',
    action,
    inbox_item_id: ctx.inboxItemId ?? null,
    contact_id: ctx.contactId ?? null,
    detail: { value, note: ctx.note ?? null },
  }));
  // Premerge technical lens (MED): the try/catch is the thing that makes the
  // "never throws" promise above true. Checking `error` only covers a Postgrest
  // error RESULT; a network-level rejection throws instead, and this is called
  // from the dismiss path, where a throw would 500 a request whose dismiss had
  // already succeeded. The comment claimed this guarantee before the code
  // delivered it.
  try {
    const { error } = await sb.from('dashboard_activity').insert(rows);
    if (error) {
      console.warn('[suppressionAudit] activity write failed (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn(
      '[suppressionAudit] activity write threw (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export type SuppressedSenderEntry = {
  /** The normalized identifier as it sits in the list. */
  value: string;
  /** Email or phone, so the UI can group them. */
  kind: 'email' | 'phone';
  /** When it was most recently suppressed, if any activity row records it. */
  suppressedAt: string | null;
  /** The actor on that row ('system' when nobody was resolved), if any. */
  suppressedBy: string | null;
  /**
   * True when this address also belongs to a real customer in the quote tool.
   * The whole point of the panel: a booked customer on this list is a mistake
   * that has been silently costing us their emails.
   */
  hasQuote: boolean;
  /** Their most advanced quote status, when they have one. */
  quoteStatus: string | null;
  /** Their name off that quote, for a recognisable row. */
  quoteName: string | null;
};

/**
 * The live suppression list, joined to whatever history and customer evidence
 * exists for each entry.
 *
 * Takes the live list as an argument rather than reading it itself: suppression.ts
 * imports THIS module for the audit write, so importing it back would make a
 * cycle. The caller already has the set.
 *
 * History is best-effort by design: the list predates this audit by months, so
 * most of the 152 existing entries have no activity row at all and correctly
 * come back with nulls. An entry with no history is still shown — hiding the
 * ones we cannot explain would defeat the purpose.
 */
export async function listSuppressedSenders(suppressed: Iterable<string>): Promise<SuppressedSenderEntry[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const values = [...suppressed];
  if (!values.length) return [];

  // Most recent suppression row per value. One query for the whole list, then
  // reduced in JS — the table is large but this action is rare, so the filter
  // is narrow.
  const bySender = new Map<string, { at: string; by: string | null }>();
  const { data: activity } = await sb
    .from('dashboard_activity')
    .select('actor, detail, created_at')
    .eq('action', SUPPRESSED_ACTION)
    .order('created_at', { ascending: false })
    .limit(2000);
  for (const row of (activity ?? []) as { actor: string | null; detail: unknown; created_at: string }[]) {
    const value = (row.detail as { value?: unknown } | null)?.value;
    if (typeof value !== 'string' || bySender.has(value)) continue;
    bySender.set(value, { at: row.created_at, by: row.actor });
  }

  // Which of these addresses belong to a real customer. Emails only: quotes
  // carry a customer_phone too, but it is stored in mixed formats and a loose
  // match here would produce false alarms on exactly the screen that exists to
  // be trusted.
  const emails = values.filter((v) => v.includes('@'));
  const quoteByEmail = new Map<string, { status: string | null; name: string | null }>();
  if (emails.length) {
    const { data: quotes } = await sb
      .from('quotes')
      .select('customer_email, customer_name, status, created_at')
      .in('customer_email', emails)
      .order('created_at', { ascending: false });
    for (const q of (quotes ?? []) as {
      customer_email: string | null;
      customer_name: string | null;
      status: string | null;
    }[]) {
      const email = q.customer_email?.toLowerCase();
      if (!email) continue;
      const existing = quoteByEmail.get(email);
      // Prefer the row that shows money: a booked or approved quote is the
      // fact that makes a suppression alarming.
      const isMoney = q.status === 'booked' || q.status === 'approved';
      if (!existing || (isMoney && existing.status !== 'booked' && existing.status !== 'approved')) {
        quoteByEmail.set(email, { status: q.status, name: q.customer_name });
      }
    }
  }

  return values
    .map((value) => {
      const history = bySender.get(value);
      const quote = quoteByEmail.get(value);
      return {
        value,
        kind: value.includes('@') ? ('email' as const) : ('phone' as const),
        suppressedAt: history?.at ?? null,
        suppressedBy: history?.by ?? null,
        hasQuote: !!quote,
        quoteStatus: quote?.status ?? null,
        quoteName: quote?.name ?? null,
      };
    })
    .sort((a, b) => {
      // Anything that looks like a real customer floats to the top — that is
      // the row someone needs to act on.
      if (a.hasQuote !== b.hasQuote) return a.hasQuote ? -1 : 1;
      return a.value.localeCompare(b.value);
    });
}
