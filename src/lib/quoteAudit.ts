// Row 411 — the ONE place that writes `quotes.approval_snapshot` with a value
// compare-and-swap, for the append-an-audit-entry family.
//
// Why this exists: the same read-modify-write + value-CAS + rowcount-check
// shape was hand-copied into three routes (integrations/highlevel/attach,
// quotes/[id]/amend, quotes/[id]/free-items), each carrying near-identical
// comments admitting it — and one copy shipped a DATA-LOSS bug found only in
// review: a discarded read error was coerced to `{}` and written back,
// REPLACING the frozen agreement (agreed total, deposit, frozen line items,
// the customer's colour selection). Every trap in this idiom now lives here
// once:
//
//   1. The filter value MUST be serialized — PostgREST string-interpolates
//      filter values, so passing the object produces "[object Object]" and the
//      CAS can never match (it would read as a permanent conflict).
//   2. `prior` MUST be a confirmed, observed value. `null`/`undefined` is a
//      bug signal ("my read failed"), never "the snapshot is legitimately
//      empty" — coercing it to `{}` is exactly the reviewed data-loss bug.
//   3. A zero-rowcount result is a LOST RACE, not success — the caller decides
//      whether that means retry, 409, or drop, but it must decide something.
//
// approval_snapshot is the frozen customer agreement. Nothing in this module
// may ever risk it to record an audit line.

import type { getSupabaseServiceClient } from '@/lib/supabase';

type ServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

export type SnapshotCasOutcome = 'landed' | 'conflict' | 'error';

/**
 * Atomically replace `approval_snapshot` with `next`, but only if it still
 * equals `prior` (the exact value the caller observed). `extraColumns` ride in
 * the SAME update so a caller that must change other columns atomically with
 * the snapshot (free-items writes `inputs` + `result`) keeps that atomicity —
 * splitting it into two writes would open the very race the CAS closes.
 *
 * Policy stays with the caller: 'conflict' is a 409 for a foreground route, a
 * retry-or-drop for a background audit write. This function only guarantees
 * the write itself cannot silently clobber a concurrent one.
 */
export async function casSwapApprovalSnapshot(
  client: ServiceClient,
  quoteId: string,
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
  logPrefix: string,
  extraColumns?: Record<string, unknown>,
): Promise<SnapshotCasOutcome> {
  // Fix round (admin lens LOW): extraColumns exists for columns that must move
  // ATOMICALLY with the snapshot (free-items' inputs/result). It must never be
  // a side door for the snapshot itself — the spread order below already makes
  // `next` win, but a caller passing approval_snapshot here is confused about
  // which argument is which, and that confusion should fail loudly in dev
  // rather than be silently corrected.
  if (extraColumns && 'approval_snapshot' in extraColumns) {
    console.error(`${logPrefix} casSwapApprovalSnapshot: approval_snapshot passed via extraColumns for quote ${quoteId} — pass it as \`next\`; the extraColumns copy is ignored`);
  }
  const { data, error } = await client
    .from('quotes')
    .update({ ...(extraColumns ?? {}), approval_snapshot: next })
    .eq('id', quoteId)
    // Trap (1): serialize explicitly, or this filter never matches anything.
    .eq('approval_snapshot', JSON.stringify(prior))
    .select('id');
  if (error) {
    // Fix round (two lenses, LOW): log the whole error object — .code/.details/
    // .hint are what an incident grep needs, and .message alone drops them.
    console.error(`${logPrefix} approval_snapshot CAS write failed for quote ${quoteId}:`, error);
    return 'error';
  }
  if (!data || data.length === 0) return 'conflict';
  return 'landed';
}

/**
 * Append one entry to a list-valued key of `approval_snapshot` (an audit
 * trail: `identityChangeRefusals`, and row 414's marker-override trail when it
 * lands), best-effort. Never the action the caller's response depends on.
 *
 * Semantics — the hardened shape from the attach route's reviewed fix:
 * - `baseSnapshot` is what the caller OBSERVED. `null`/`undefined` means its
 *   read failed or found no row: SKIP with a warning (trap 2). Losing an audit
 *   line is acceptable; replacing the frozen agreement to record one is not.
 * - One silent retry on a lost race, against a FRESH read — and a failed
 *   re-read skips again rather than degrading to `{}`.
 * - Returns true only when the entry landed. Callers must not fail their
 *   request on false; if the audit line is load-bearing, use
 *   casSwapApprovalSnapshot directly and handle 'conflict' yourself.
 */
export async function appendQuoteAuditEntry(
  client: ServiceClient,
  quoteId: string,
  key: string,
  entry: unknown,
  logPrefix: string,
  baseSnapshot: unknown,
): Promise<boolean> {
  try {
    let snapshot: unknown = baseSnapshot;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (snapshot == null) {
        console.warn(
          `${logPrefix} audit append of '${key}' SKIPPED for quote ${quoteId} (attempt ${attempt}) — no confirmed approval_snapshot to merge onto; writing one from nothing risks replacing the frozen agreement.`,
        );
        return false;
      }
      const prior = typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : {};
      const priorList = Array.isArray(prior[key]) ? (prior[key] as unknown[]) : [];
      const next = { ...prior, [key]: [...priorList, entry] };
      const outcome = await casSwapApprovalSnapshot(client, quoteId, prior, next, logPrefix);
      if (outcome === 'landed') return true;
      if (outcome === 'error') return false; // already logged; don't hammer a failing write
      if (attempt === 0) {
        // Lost the race — something else (the customer's own /approve or /pay,
        // a staff amend) moved the snapshot in the gap. Re-read and retry once
        // against the CURRENT value; a failed re-read leaves `snapshot`
        // undefined, which the top-of-loop guard catches (trap 2 again).
        const { data, error } = await client
          .from('quotes')
          .select('approval_snapshot')
          .eq('id', quoteId)
          .maybeSingle<{ approval_snapshot: unknown }>();
        snapshot = error || !data ? undefined : data.approval_snapshot;
        continue;
      }
      console.warn(
        `${logPrefix} audit append of '${key}' lost the optimistic-concurrency race twice for quote ${quoteId}; entry not recorded.`,
      );
    }
    return false;
  } catch (err) {
    console.warn(`${logPrefix} audit append of '${key}' threw for quote ${quoteId}:`, err);
    return false;
  }
}
