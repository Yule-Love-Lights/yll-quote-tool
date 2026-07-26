// Aggregate daily SPEND guard for the public self-serve estimator.
//
// /api/estimate spends real money per accepted request: the Claude analyzer +
// Google Maps imagery. The per-IP rate limit bounds ONE attacker's rate, but
// nothing bounded the TOTAL across all IPs — a distributed bot could run up the
// bill (the pre-launch security review's one MEDIUM). This is the hard ceiling:
// a global count of paid analyzer runs per (UTC) day, checked before the spend.
// Over the cap → the route routes the visitor to follow-up lead capture (still a
// lead, no hard error) instead of spending.
//
// Complements, does not replace, Cloudflare Turnstile: Turnstile stops bots at
// the door (protects AVAILABILITY — real customers still get through when a bot
// storm would otherwise exhaust the budget); this counter protects the BILL
// regardless. Turnstile needs a Cloudflare account + keys; this needs neither.

import { getSupabaseServiceClient } from '@/lib/supabase';

export const DEFAULT_DAILY_ANALYZER_CAP = 300;

/**
 * The daily cap, from SELF_SERVE_DAILY_ANALYZER_CAP, or the default. Tolerant:
 * only a positive integer overrides; anything else (blank, garbage, 0, negative,
 * float, exponent) falls back to the default rather than silently disabling or
 * mis-setting the guard. Pure — unit-tested.
 */
export function resolveDailyCap(raw: string | undefined): number {
  if (!raw || !raw.trim()) return DEFAULT_DAILY_ANALYZER_CAP;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_ANALYZER_CAP;
}

/**
 * True when a request may spend. `count` is the post-increment count for today
 * (the Nth call sees count === N); a null count means the counter was
 * unreadable, in which case we FAIL OPEN — the per-IP limit still applies, and a
 * transient DB error must not take the whole feature down. Pure — unit-tested.
 */
export function isWithinBudget(count: number | null, cap: number): boolean {
  if (count == null) return true; // fail open
  return count <= cap;
}

export type BudgetDecision = { allowed: boolean; count: number | null; cap: number };

/**
 * Atomically consume one unit of today's analyzer budget and decide if the
 * request may proceed. Calls the bump_self_serve_analyzer_budget() RPC (an
 * atomic UPSERT-increment) so concurrent lambdas across regions share one
 * counter. Best-effort + FAIL-OPEN: no service client, a missing table/RPC (not
 * migrated yet), or any error → allowed:true (the per-IP limit is still in
 * front). Call this AFTER the free geocode/precision/service-area gates and
 * BEFORE the paid imagery + analyzer, so only genuinely-billable requests count.
 */
export async function consumeAnalyzerBudget(): Promise<BudgetDecision> {
  const cap = resolveDailyCap(process.env.SELF_SERVE_DAILY_ANALYZER_CAP);
  const sb = getSupabaseServiceClient();
  if (!sb) return { allowed: true, count: null, cap };
  try {
    const { data, error } = await sb.rpc('bump_self_serve_analyzer_budget');
    if (error) {
      console.warn('[selfServe] budget RPC failed (not migrated? failing open):', error.message);
      return { allowed: true, count: null, cap };
    }
    const count = typeof data === 'number' ? data : Number(data);
    const resolved = Number.isFinite(count) ? count : null;
    return { allowed: isWithinBudget(resolved, cap), count: resolved, cap };
  } catch (err) {
    console.warn('[selfServe] budget check threw (failing open):', err instanceof Error ? err.message : 'error');
    return { allowed: true, count: null, cap };
  }
}
