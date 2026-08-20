// Canonical service-line type for a quote: Holiday / Permanent / Event
// (per docs/dashboard/VISION.md §4). Lives in this tiny, dependency-free
// module so BOTH the server data layer (lib/quotes.ts, the /api/quote route)
// and client UI (the quote builder) can import it without pulling server-only
// code (Supabase) into the client bundle.
//
// ⚠️ POST-MERGE DEDUPE: the dashboard (src/lib/dashboard/types.ts, #58 Phase 2a)
// currently defines its own identical `ServiceType`/`SERVICE_TYPES`. Once both
// the dashboard and this builder change are on master, point that module at
// this one (re-export) so there is a single source of truth.

export type ServiceType = 'holiday' | 'permanent' | 'event' | 'permanent_bistro';

export const SERVICE_TYPES: readonly ServiceType[] = ['holiday', 'permanent', 'event', 'permanent_bistro'] as const;

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  holiday: 'Holiday',
  permanent: 'Permanent',
  event: 'Event',
  permanent_bistro: 'Bistro',
};

/** The default for any quote that hasn't been explicitly categorized. Matches
 *  the DB migration's backfill (NULL service_type reads as 'holiday'). */
export const DEFAULT_SERVICE_TYPE: ServiceType = 'holiday';

/** Narrow an unknown value to a ServiceType, or null if it isn't one. */
export function asServiceType(v: unknown): ServiceType | null {
  return typeof v === 'string' && (SERVICE_TYPES as readonly string[]).includes(v)
    ? (v as ServiceType)
    : null;
}

/** Whether the customer portal's LightColorPicker applies to this vertical
 *  (#48/#57, permanent via #88 P6b-4, #117 for the bistro exclusion). A
 *  POSITIVE list (never `!== 'permanent'`/`!== 'permanent_bistro'`) so a
 *  FUTURE vertical must opt in rather than inherit recolor UI by default —
 *  permanent bistro is deliberately excluded (warm-white Edison bulbs only,
 *  per its FAQ). Single source of truth for that gate: both the picker
 *  itself (src/app/portal/[quoteId]/page.tsx) and any control that jumps to
 *  it (DesignReprise's "Click here to change colors") call this instead of
 *  carrying their own copy of the condition, so the two can never drift
 *  apart (#245). */
export function canCustomerRecolor(serviceType: ServiceType | null | undefined): boolean {
  return (
    serviceType == null ||
    serviceType === 'holiday' ||
    serviceType === 'permanent' ||
    serviceType === 'event'
  );
}

/** Whether a quote of this service type may carry the NCE tag (the
 *  barter/trade network) or the YLL Neighbor tag (#243). Domain rule locked
 *  2026-08-11: permanent lighting is always real money, never trade —
 *  permanent, event, and permanent_bistro quotes can carry NEITHER tag.
 *  HOLIDAY-ONLY, a POSITIVE match (`=== 'holiday'`) per the repo convention
 *  — a negative gate would silently hand every FUTURE vertical the old
 *  (wrong) behavior. null/undefined reads as holiday, matching
 *  DEFAULT_SERVICE_TYPE/the migration backfill, so an un-categorized legacy
 *  row is still eligible. Single source of truth: every set/inherit site
 *  (the builder chips, the nce/legacy-rebook admin toggle routes, the main
 *  quote save route, lead-prefill, contact-pick inheritance, and rebook)
 *  calls this instead of carrying its own `=== 'holiday'` copy, so they can
 *  never drift apart (mirrors canCustomerRecolor's own doc, #245). */
export function canCarryNceOrYllNeighborTag(serviceType: ServiceType | null | undefined): boolean {
  return serviceType == null || serviceType === 'holiday';
}
