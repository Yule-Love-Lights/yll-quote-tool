// Shared money-rounding helpers (#110 W1-064). The same round-to-cents logic was
// copy-pasted across the money modules in TWO deliberately-different variants,
// held in sync only by comments. This is the single home for both — behavior is
// byte-identical to the copies it replaces, so nothing rounds differently.
//
// The two variants differ on purpose — pick per call site:
//  • roundMoneyGuarded — the #83 invoice/amend/balance variant: EPSILON-nudged
//    (so a value sitting exactly on a half-cent boundary rounds up predictably)
//    AND finite-guarded (a non-finite input coerces to 0, so a malformed legacy
//    result can never write NaN into a stored balance).
//  • roundMoney — the portal/approve variant: a plain round-to-cents with no
//    EPSILON nudge and no finiteness guard (those call sites hard-validate their
//    inputs upstream, and the portal preview must match the engine's own rounding).

// #83 money-core rounding: EPSILON-nudged + finite-guarded. Used by invoices.ts,
// amend.ts, balanceCollection.ts so the balance a customer is charged rounds
// identically across the amend → invoice → collection chain.
export function roundMoneyGuarded(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Plain round-to-cents (portal/approve variant). Used by derivePackages.ts and
// the approve route, whose inputs are validated upstream and which must mirror
// the pricing engine's own Math.round(x * 100) / 100.
// Multiply a currency amount by a decimal rate without letting binary floating-
// point move an exact half-cent below the rounding boundary. Both operands are
// converted to integers first: cents for the amount, millionths for the rate.
// One millionth supports rates through four decimal places (including 8.75%)
// with room for future local-rate precision. Quote-sized values stay well below
// Number.MAX_SAFE_INTEGER during the multiplication.
export function moneyTimesRate(amountUsd: number, rate: number): number {
  if (!Number.isFinite(amountUsd) || !Number.isFinite(rate)) return NaN;
  const amountCents = Math.round(amountUsd * 100);
  const rateMillionths = Math.round(rate * 1_000_000);
  return Math.round((amountCents * rateMillionths) / 1_000_000) / 100;
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
