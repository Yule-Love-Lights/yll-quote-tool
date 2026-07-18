// #154 interim — Wisetack financing eligibility. PURE, no I/O, client-safe
// (imports only the shared money rounding + the ServiceType type), so both the
// server (portal loader / approved page) and the client (the live-selection
// approve modal) evaluate the SAME rules and can never drift.
//
// This is the interim prequal-CTA slice: full Wisetack API access is pending,
// so the CTA links out to the merchant's real prequal URL. When the API build
// lands (the committed plan in docs/superpowers/plans/2026-07-14-wisetack-
// portal-financing.md), the /finance route reuses these exact rules.
//
// Money representation (per the plan's "Money representation note"): payment-
// layer money is USD numbers rounded with roundMoneyGuarded (aliased round2) —
// the same variant invoices/amend/balanceCollection use — so the financed
// balance always matches what the balance chain would bill.

import { roundMoneyGuarded as round2 } from '@/lib/money';
import type { ServiceType } from '@/lib/serviceType';

// Wisetack's financeable range, inclusive on both ends.
export const WISETACK_MIN_USD = 500;
export const WISETACK_MAX_USD = 25000;

// YLL business floor (Naldo, 2026-07-18): financing is offered only on jobs
// of $1,500 and up — gated on the JOB TOTAL (the agreed, tax-inclusive price),
// not the financed balance. Wisetack's own [500, 25000] range still applies to
// the balance on top of this.
export const YLL_FINANCING_MIN_JOB_TOTAL_USD = 1500;

/** The financed amount: agreed total minus the deposit, rounded to cents. */
export function financedBalanceUsd(agreedTotalUsd: number, depositUsd: number): number {
  return round2(agreedTotalUsd - depositUsd);
}

/**
 * Whether the financing CTA shows. POSITIVE gate on every leg (per the
 * AGENTS.md seam rule): the flag must be exactly on, the service type exactly
 * holiday, permanent, or permanent_bistro (bistro added by Naldo 2026-07-18;
 * event / unknown are OUT — a future vertical must opt in, never inherit),
 * the JOB TOTAL at least $1,500 (the YLL business floor), and the balance
 * inside Wisetack's [$500, $25,000].
 */
const FINANCEABLE_SERVICE_TYPES: ReadonlySet<ServiceType> = new Set([
  'holiday',
  'permanent',
  'permanent_bistro',
]);

export function isFinancingEligible(input: {
  enabled: boolean;
  serviceType: ServiceType | null | undefined;
  totalUsd: number;
  balanceUsd: number;
}): boolean {
  if (input.enabled !== true) return false;
  if (input.serviceType == null || !FINANCEABLE_SERVICE_TYPES.has(input.serviceType)) return false;
  if (!(input.totalUsd >= YLL_FINANCING_MIN_JOB_TOTAL_USD)) return false;
  return input.balanceUsd >= WISETACK_MIN_USD && input.balanceUsd <= WISETACK_MAX_USD;
}
