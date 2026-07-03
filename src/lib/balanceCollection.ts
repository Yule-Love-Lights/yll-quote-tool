// Balance-collection ROUTING (ledger #83, Phase 3) — PURE, no money movement.
//
// SPEC §4.3: when an invoice is created, collect the remaining balance via Valor
// — "auto-charge the saved vault card; on decline/no-card → send the customer a
// portal pay-balance link." This module decides WHICH path applies. It does NOT
// execute either one.
//
// ⚠️ Execution is deliberately deferred:
//   • auto_charge — a server-side card-on-file (MIT) sale on the stored
//     valor_vault_token. The current Valor integration does deposits via
//     Passage.js / a hosted page and explicitly builds "no auto-charge"
//     (2026-06-24-quotes-add-valor-payment.sql), so this path needs a confirmed
//     Valor MIT capability + Jason's integration work. OPEN DECISION.
//   • pay_link — a hosted-page sale for the balance, reusing the PROVEN
//     createHostedPageSale flow. The safe fallback.
// Both are operator/customer surfaces that move money → gated on #81 (auth).
//
// Keeping the routing pure + tested means the decision logic is settled and
// reviewable now; only the execution waits on the decision + auth.

// #110 W1-064: shared EPSILON-nudged + finite-guarded round-to-cents (was copy-
// pasted here / invoices.ts / amend.ts). Aliased to `round2` so call sites are
// byte-identical.
import { roundMoneyGuarded as round2 } from './money';

export type BalanceCollectionPlan =
  | { method: 'none'; amountUsd: 0; reason: 'no_balance' | 'overpaid' }
  | { method: 'auto_charge'; amountUsd: number }
  | { method: 'pay_link'; amountUsd: number };

/**
 * Decide how to collect an invoice's balance. PURE.
 *   • balance ≤ 0 → nothing to collect (paid in full by the deposit, or overpaid
 *     → a manual refund, surfaced as `overpaid`).
 *   • balance > 0 + a saved vault token → auto_charge.
 *   • balance > 0 + no token → pay_link (the customer pays the balance themselves).
 */
export function planBalanceCollection(input: {
  balance: number;
  creditNote?: number;
  hasVaultToken: boolean;
}): BalanceCollectionPlan {
  if ((input.creditNote ?? 0) > 0) return { method: 'none', amountUsd: 0, reason: 'overpaid' };

  const balance = round2(input.balance);
  if (balance <= 0) return { method: 'none', amountUsd: 0, reason: 'no_balance' };

  return input.hasVaultToken
    ? { method: 'auto_charge', amountUsd: balance }
    : { method: 'pay_link', amountUsd: balance };
}
