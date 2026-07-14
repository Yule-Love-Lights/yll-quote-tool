// Referral program growth feature 3 (ledger #41 growth) — the operator
// dashboard's read-only "Referrals" measurement tile. Split the same way as
// serviceMetrics.ts/queries.ts: `computeReferralMetrics` is a PURE function
// over already-fetched rows (independently testable, no Supabase needed);
// `loadReferralMetrics` does the batched I/O and hands it plain arrays/maps.

import { getSupabaseServiceClient, getSupabaseClient } from '@/lib/supabase';
import type { ReferralStatus } from '@/lib/referrals';

/** The columns this surface actually reads from `referrals`. */
export type ReferralMetricsRow = {
  id: string;
  referrer_customer_id: string | null;
  referee_quote_id: string | null;
  status: ReferralStatus;
};

export type ReferralMetrics = {
  /** All referral rows generated (any status), after test-quote exclusion. */
  totalReferrals: number;
  /** (booked + credited) / totalReferrals. Null when totalReferrals is 0. */
  bookedConversionRate: number | null;
  /** $ sum of the linked quotes' totals for booked/credited referrals when at
   *  least one resolves; otherwise a plain count of booked/credited referrals
   *  (e.g. the quotes lookup found none — showing "$0" would misleadingly
   *  imply zero revenue rather than "unresolved"). */
  revenueInfluenced: { kind: 'usd'; amountUsd: number } | { kind: 'count'; count: number };
  /** Up to 3 referrers ranked by booked+credited count, ties broken by
   *  customer id for a stable order. */
  topReferrers: Array<{ customerId: string; name: string; convertedCount: number }>;
};

const EMPTY_METRICS: ReferralMetrics = {
  totalReferrals: 0,
  bookedConversionRate: null,
  revenueInfluenced: { kind: 'count', count: 0 },
  topReferrers: [],
};

const CONVERTED_STATUSES: ReadonlyArray<ReferralStatus> = ['booked', 'credited'];

/**
 * Pure compute: conversion math, revenue-influenced sum, and the top-3
 * referrer ranking. `quoteTotalsById` and `referrerNamesById` are pre-resolved
 * by the caller (loadReferralMetrics) via batched lookups — this function
 * does no I/O and needs no Supabase mock to test.
 */
export function computeReferralMetrics(
  rows: ReferralMetricsRow[],
  quoteTotalsById: Map<string, number>,
  referrerNamesById: Map<string, string>,
): ReferralMetrics {
  const totalReferrals = rows.length;
  if (totalReferrals === 0) return EMPTY_METRICS;

  const converted = rows.filter((r) => CONVERTED_STATUSES.includes(r.status));
  const bookedConversionRate = converted.length / totalReferrals;

  // accrueOnBooking (src/lib/referrals.ts) only ever flips a row that ALREADY
  // has a referee_quote_id, so every converted row has one in practice —
  // quoteTotalsById simply won't have an entry if that particular quote
  // lookup missed (e.g. the row was deleted), in which case it just doesn't
  // contribute to the sum below.
  const resolvedTotals = converted
    .map((r) => (r.referee_quote_id ? quoteTotalsById.get(r.referee_quote_id) : undefined))
    .filter((n): n is number => typeof n === 'number');

  const revenueInfluenced: ReferralMetrics['revenueInfluenced'] =
    resolvedTotals.length > 0
      ? { kind: 'usd', amountUsd: resolvedTotals.reduce((sum, n) => sum + n, 0) }
      : { kind: 'count', count: converted.length };

  const countByReferrer = new Map<string, number>();
  for (const r of converted) {
    if (!r.referrer_customer_id) continue;
    countByReferrer.set(r.referrer_customer_id, (countByReferrer.get(r.referrer_customer_id) ?? 0) + 1);
  }
  const topReferrers = Array.from(countByReferrer.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([customerId, convertedCount]) => ({
      customerId,
      name: referrerNamesById.get(customerId) ?? 'Unknown customer',
      convertedCount,
    }));

  return { totalReferrals, bookedConversionRate, revenueInfluenced, topReferrers };
}

/**
 * Batched read + compute for the dashboard tile. THREE round trips total,
 * regardless of table size (no N+1): all referral rows, then one `.in()` for
 * the linked quotes (also carrying `is_test` for exclusion), then one `.in()`
 * for the converted referrers' names.
 *
 * Test Quote isolation (ledger #93): a referral whose linked quote is a
 * seeded is_test row must not skew this surface — same derive-via-quote-link
 * pattern as listJobsForWorkflowBoard/listInvoicesForWorkflowBoard in
 * queries.ts. BEST-EFFORT: returns EMPTY_METRICS on any error, including the
 * referrals table not existing yet. Server-only.
 */
export async function loadReferralMetrics(): Promise<ReferralMetrics> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return EMPTY_METRICS;

  try {
    const { data, error } = await sb
      .from('referrals')
      .select('id, referrer_customer_id, referee_quote_id, status');
    if (error) {
      console.warn('loadReferralMetrics (table not migrated yet?):', error.message);
      return EMPTY_METRICS;
    }
    let rows = (data ?? []) as unknown as ReferralMetricsRow[];
    if (rows.length === 0) return EMPTY_METRICS;

    const allQuoteIds = [...new Set(rows.map((r) => r.referee_quote_id).filter((x): x is string => !!x))];
    const quoteTotalsById = new Map<string, number>();
    if (allQuoteIds.length) {
      const { data: qrows } = await sb.from('quotes').select('id, total, is_test').in('id', allQuoteIds);
      const testQuoteIds = new Set<string>();
      for (const q of (qrows ?? []) as Array<{ id: string; total: number | null; is_test: boolean | null }>) {
        if (q.is_test) testQuoteIds.add(q.id);
        else if (typeof q.total === 'number') quoteTotalsById.set(q.id, q.total);
      }
      rows = rows.filter((r) => !(r.referee_quote_id && testQuoteIds.has(r.referee_quote_id)));
    }
    if (rows.length === 0) return EMPTY_METRICS;

    const converted = rows.filter((r) => CONVERTED_STATUSES.includes(r.status));
    const referrerIds = [...new Set(converted.map((r) => r.referrer_customer_id).filter((x): x is string => !!x))];
    const namesById = new Map<string, string>();
    if (referrerIds.length) {
      const { data: crows } = await sb.from('customers').select('id, name').in('id', referrerIds);
      for (const c of (crows ?? []) as Array<{ id: string; name: string | null }>) {
        namesById.set(c.id, c.name?.trim() || 'Unnamed customer');
      }
    }

    return computeReferralMetrics(rows, quoteTotalsById, namesById);
  } catch (err) {
    console.warn('loadReferralMetrics failed:', err);
    return EMPTY_METRICS;
  }
}
