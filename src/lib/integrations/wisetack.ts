// #154 INTERIM — Wisetack financing config (prequal-CTA slice only).
//
// Full Wisetack API access is pending the partner grant, so this module holds
// ONLY the two env reads the interim portal CTA needs. The full client (create/
// get transaction, webhook verify/parse — see docs/superpowers/plans/
// 2026-07-14-wisetack-portal-financing.md) is built LATER, in this same file,
// when creds arrive. No wire formats are invented here.
//
// Read on the SERVER at request time (same pattern as valorCheckout.ts): the
// portal loader/page computes the result and threads it down as a prop, so the
// flag never bakes into the client bundle and flipping the env var just needs
// a redeploy.

/** The customer-facing kill switch. Financing shows only when this is exactly "true". */
export function isWisetackFinancingEnabled(): boolean {
  return process.env.WISETACK_FINANCING_ENABLED === 'true';
}

/**
 * The merchant's real Wisetack prequal link the CTA opens. null when unset or
 * blank — and a null URL keeps the feature OFF regardless of the flag (there
 * is nothing safe to link to).
 */
export function getWisetackPrequalUrl(): string | null {
  const url = process.env.WISETACK_PREQUAL_URL?.trim();
  return url ? url : null;
}
