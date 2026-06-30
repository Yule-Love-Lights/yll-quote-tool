// Balance auto-charge SEAM (ledger #83). The "Charge remaining balance" operator
// action collects an invoice's balance by charging the card saved at deposit
// (quotes.valor_vault_token) via Valor's "Direct Sale - Token" API
// (POST {securelink…}/?saleToken), auth'd with the appid/appkey/epi we already
// hold. See docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md for the contract.
//
// ⚠️ STUBBED + flag-gated. A server-initiated card-on-file (MIT) charge needs a
// CONFIRMED Valor capability + Jason's payments work (3 open confirmations in the
// doc above). Until VALOR_AUTO_CHARGE_ENABLED is truthy AND Jason fills in the
// /?saleToken call below, this makes NO Valor call and reports a non-ok reason so
// the caller falls back to manual / pay-link collection. Isolating the charge here
// means the operator surfaces ship now and the charge flips on with one env var
// once Valor is confirmed — no rework.

export type ChargeBalanceInput = {
  vaultToken: string | null; // quotes.valor_vault_token — the card on file
  amountUsd: number; // the invoice balance to collect
  orderRef: string; // our reference, round-tripped by the webhook (→ invoicenumber)
  taxUsd?: number;
  customerName?: string | null;
  customerEmail?: string | null;
};

export type ChargeBalanceResult =
  | { ok: true; txnId: string | null; approvalCode: string | null; receiptUrl: string | null; raw: unknown }
  | { ok: false; reason: 'not-enabled' | 'no-card' | 'declined' | 'error'; message?: string };

// Single flag gate. OFF by default — flip in Vercel ONLY after Valor's
// card-on-file capability is confirmed + a real $ test charge then voided (same
// discipline as the #38 deposit go-live). Tolerant parsing like valorCheckout.ts.
export function isAutoChargeEnabled(): boolean {
  const v = process.env.VALOR_AUTO_CHARGE_ENABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Charge an invoice's balance against the card on file. STUB until Jason wires the
 * real Valor call (see the module header + the handoff doc). Returns:
 *   - not-enabled — the flag is off (the default; no Valor capability confirmed).
 *   - no-card     — enabled but the quote has no saved vault token.
 *   - error       — enabled + token present, but the real charge isn't implemented
 *                   yet (so we NEVER silently no-op a real collection).
 * The caller treats any non-ok result as "not collected" and leaves the invoice
 * awaiting_payment for manual / pay-link follow-up.
 */
export async function chargeBalanceOnFile(input: ChargeBalanceInput): Promise<ChargeBalanceResult> {
  if (!isAutoChargeEnabled()) return { ok: false, reason: 'not-enabled' };
  if (!input.vaultToken) return { ok: false, reason: 'no-card' };

  // TODO (Jason — payments area): POST {securelink[-staging].valorpaytech.com}/?saleToken
  //   body: appid/appkey/epi (process.env.VALOR_APP_ID/APP_KEY/EPI), txn_type 'sale',
  //   amount (2dp string of input.amountUsd), token=input.vaultToken,
  //   invoicenumber=input.orderRef, surchargeIndicator '0', tax_amount as needed.
  //   Parse error_no 'S00' => { ok:true, txnId, approvalCode, receiptUrl, raw };
  //   else declined. Mirror createHostedPageSale's defensive parsing in valor.ts.
  //   Do NOT enable until the 3 confirmations in VALOR-AUTOCHARGE-FOR-JASON.md pass.
  return {
    ok: false,
    reason: 'error',
    message: 'chargeBalanceOnFile is not implemented yet (pending Valor card-on-file confirmation)',
  };
}
