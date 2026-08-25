// Row 362: approved light-colour labels for a set of quotes, keyed by quote id.
//
// A separate, additive module rather than a new field on the shared
// listQuotesForDashboard query: that query feeds Naldo's whole dashboard, and
// widening it to carry approval_snapshot for every quote in a 500-row list
// would pull a large jsonb column across every board render to serve one
// column on one page. This fetches only the ids a page is actually showing.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { chosenLightColorLabelFromSnapshot } from './chosenColorLabel';

/**
 * Map of quoteId -> label. Quotes with no approved colour are simply absent,
 * so callers can render nothing rather than an empty placeholder.
 *
 * Best-effort by design: this is a display nicety on pages whose primary job
 * is something else, so a Supabase hiccup returns an empty map and the page
 * renders exactly as it did before row 362 — it must never 500 a customer
 * profile over a colour chip.
 */
export async function getApprovedColorLabels(quoteIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (quoteIds.length === 0) return out;
  const db = getSupabaseServiceClient();
  if (!db) return out;
  try {
    const { data, error } = await db
      .from('quotes')
      .select('id, approval_snapshot')
      .in('id', quoteIds);
    if (error || !data) return out;
    for (const row of data as Array<{ id: string; approval_snapshot: unknown }>) {
      const label = chosenLightColorLabelFromSnapshot(row.approval_snapshot);
      if (label) out.set(row.id, label);
    }
  } catch {
    return out;
  }
  return out;
}
