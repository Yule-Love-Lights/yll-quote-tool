// Row 362: the approved light-colour label for a quote, resolved against the
// RIGHT swatch list for that quote's vertical.
//
// The vertical matters, and getting it wrong is silent. Holiday and permanent
// quotes freeze their colour into DISJOINT id spaces — permanent has `blue`,
// `orange`, `rainbow`, `spooky`, `patriotic`; holiday has `champagne`,
// `candy-cane`, `christmas`, `blue-white`. `getColorScheme` does not report a
// miss: an id it cannot find falls back to `as-designed`, whose label is
// "Staff's pick". So resolving a permanent quote against the holiday list does
// not error or blank — it CONFIDENTLY DISPLAYS THE WRONG COLOUR.
//
// A premerge technical lens caught exactly that in the first cut of this
// feature, and a prod measurement confirmed it was not hypothetical: of 22
// live approved quotes carrying a colour, one (booked permanent quote #1303,
// approved "Orange") would have rendered as "Staff's pick" on the job page the
// crew builds from. That is the same class of defect row 362 exists to fix, so
// shipping it inside the fix would have been the worst possible outcome.
//
// Hence: callers pass the quote's service type, never a scheme list. The list
// comes from app_settings — the same source the approve and apply-colour
// routes use — so staff-customised swatches resolve correctly too, on both
// verticals.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { getAppSettings } from '@/lib/appSettings';
import type { ColorScheme } from './colorSchemes';
import { chosenLightColorLabel } from './chosenColorLabel';

/** The live swatch list for a vertical, from app_settings. */
export async function activeSchemesForServiceType(serviceType: string | null | undefined): Promise<ColorScheme[]> {
  const { swatches, permanentSwatches } = await getAppSettings();
  // Mirrors apply-color-request/approve: only 'permanent' uses the permanent
  // swatch list. permanent_bistro quotes are priced separately but pick from
  // the holiday swatches, same as those routes treat them.
  return serviceType === 'permanent' ? permanentSwatches.schemes : swatches.schemes;
}

/** The label for one quote's approval snapshot, or null when there is none. */
export async function approvedColorLabelForQuote(
  approvalSnapshot: unknown,
  serviceType: string | null | undefined,
): Promise<string | null> {
  if (!approvalSnapshot || typeof approvalSnapshot !== 'object') return null;
  const sel = (approvalSnapshot as { customerSelection?: { colorSchemeId?: string; customPattern?: string[] } })
    .customerSelection;
  if (!sel) return null;
  return chosenLightColorLabel(sel, await activeSchemesForServiceType(serviceType));
}

export type ApprovedColorLookup = {
  labels: Map<string, string>;
  /**
   * False when the lookup itself failed. A premerge staff lens caught that
   * returning a bare empty map made "this customer approved no colour" and
   * "the query fell over" render the SAME em dash — a silent wrong negative on
   * precisely the question this feature exists to answer. The caller needs to
   * be able to tell those apart, so the outcome is reported alongside the data
   * rather than collapsed into it.
   */
  ok: boolean;
};

/**
 * Labels for a set of quotes, plus whether the lookup succeeded.
 *
 * A separate query rather than widening listQuotesForDashboard: that feeds the
 * whole dashboard, and dragging a large jsonb column across every board render
 * to serve one column on one page is the wrong trade.
 *
 * Never throws — this is a display column on a page whose primary job is
 * something else, and it must not 500 a customer profile over a chip. But a
 * failure is REPORTED (ok: false) instead of being disguised as "no colour".
 */
export async function getApprovedColorLabels(quoteIds: string[]): Promise<ApprovedColorLookup> {
  const out = new Map<string, string>();
  if (quoteIds.length === 0) return { labels: out, ok: true };
  const db = getSupabaseServiceClient();
  if (!db) return { labels: out, ok: false };
  try {
    const { data, error } = await db
      .from('quotes')
      .select('id, service_type, approval_snapshot')
      .in('id', quoteIds);
    if (error || !data) return { labels: out, ok: false };
    // Settings are fetched ONCE per vertical, not per row.
    const cache = new Map<string, ColorScheme[]>();
    for (const row of data as Array<{ id: string; service_type: string | null; approval_snapshot: unknown }>) {
      const key = row.service_type === 'permanent' ? 'permanent' : 'other';
      if (!cache.has(key)) cache.set(key, await activeSchemesForServiceType(row.service_type));
      const snap = row.approval_snapshot;
      if (!snap || typeof snap !== 'object') continue;
      const sel = (snap as { customerSelection?: { colorSchemeId?: string; customPattern?: string[] } }).customerSelection;
      const label = chosenLightColorLabel(sel, cache.get(key));
      if (label) out.set(row.id, label);
    }
  } catch {
    return { labels: out, ok: false };
  }
  return { labels: out, ok: true };
}
