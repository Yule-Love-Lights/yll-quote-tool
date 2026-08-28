// Row 423 — who changed the drawing on a job the customer already paid for.
//
// Row 367 freezes the design once a customer approves, with ONE deliberate
// exception: a BOOKED order stays editable, because that is the sanctioned
// amend path (edit in the builder, then record the amendment). So the only
// design changes that can land on a signed-off quote are exactly the ones the
// owner most needs a record of — and there was none. The sibling row-370 code
// audits a portal-visibility toggle onto the same snapshot; a change to the
// picture itself was silent.
//
// COARSE ON PURPOSE. The editor autosaves on a 600ms debounce, so an entry per
// write would put hundreds of rows behind one afternoon's editing and bury the
// signal it exists to provide. One entry per operator, per design, per calendar
// day answers the real question ("who touched this, and when") at a resolution
// a person can actually read. The first edit of a day writes; the rest are
// no-ops.
//
// Best-effort by contract, exactly like row 370's: losing this line is
// acceptable, breaking a design save (or the frozen agreement) to record it is
// not. Never throws.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { getOperator } from '@/lib/auth/supabaseServer';
import { appendQuoteAuditEntry } from '@/lib/quoteAudit';

const KEY = 'designChanges';
const LOG = '[design-audit]';

export type DesignChangeEntry = {
  by: string | null;
  at: string;
  designId: string;
  /** The calendar day this entry covers, in ET — the business's own day. */
  day: string;
};

/**
 * The business day for a timestamp, in America/New_York. Deliberately NOT the
 * UTC day: staff working an evening in ET would otherwise straddle two "days"
 * mid-session and write a second entry at 8pm — the same UTC-vs-ET trap ledger
 * row 335 records for the schedule page.
 */
export function businessDay(at: Date): string {
  // en-CA gives YYYY-MM-DD, which sorts and compares as a plain string.
  return at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * True when this operator already has an entry for this design on this day, so
 * the append can be skipped.
 */
export function alreadyRecorded(
  snapshot: unknown,
  designId: string,
  by: string | null,
  day: string,
): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const list = (snapshot as Record<string, unknown>)[KEY];
  if (!Array.isArray(list)) return false;
  return list.some((e) => {
    if (!e || typeof e !== 'object') return false;
    const entry = e as Partial<DesignChangeEntry>;
    return entry.designId === designId && entry.by === by && entry.day === day;
  });
}

/**
 * Record that this operator changed this design today, once per day.
 * `at` is injectable so the day boundary can be tested without waiting for one.
 */
export async function recordDesignChange(
  designId: string,
  quoteId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return;
    const { data: quoteRow, error } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', quoteId)
      .maybeSingle<{ approval_snapshot: unknown }>();
    if (error || !quoteRow) {
      // Same reasoning as row 370's audit: the legitimate no-op (no snapshot)
      // is silent below, but a real read failure must leave a trace — this
      // trail's whole purpose is a record, so it must not go dark quietly.
      console.warn(`${LOG} skipped — quote snapshot read failed or no row:`, error?.message ?? 'no row');
      return;
    }
    const operator = await getOperator();
    const by = operator?.email ?? null;
    const day = businessDay(at);
    if (alreadyRecorded(quoteRow.approval_snapshot, designId, by, day)) return;
    const entry: DesignChangeEntry = { by, at: at.toISOString(), designId, day };
    await appendQuoteAuditEntry(sb, quoteId, KEY, entry, LOG, quoteRow.approval_snapshot);
  } catch (err) {
    console.warn(`${LOG} append threw:`, err);
  }
}
