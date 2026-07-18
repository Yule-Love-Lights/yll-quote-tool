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

/** The financed amount: agreed total minus the deposit, rounded to cents. */
export function financedBalanceUsd(agreedTotalUsd: number, depositUsd: number): number {
  return round2(agreedTotalUsd - depositUsd);
}

/**
 * Whether the financing CTA shows. POSITIVE gate on every leg (per the
 * AGENTS.md seam rule): the flag must be exactly on, the service type exactly
 * holiday or permanent (event / bistro / unknown are OUT — a future vertical
 * must opt in, never inherit), and the balance inside [$500, $25,000].
 */
export function isFinancingEligible(input: {
  enabled: boolean;
  serviceType: ServiceType | null | undefined;
  balanceUsd: number;
}): boolean {
  if (input.enabled !== true) return false;
  if (input.serviceType !== 'holiday' && input.serviceType !== 'permanent') return false;
  return input.balanceUsd >= WISETACK_MIN_USD && input.balanceUsd <= WISETACK_MAX_USD;
}
