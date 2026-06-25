// Single source of truth for the #38 customer-facing deposit-checkout feature
// flag. The embedded Passage.js checkout ships DARK (off) and is flipped on only
// after the end-to-end staging test passes — so merging the checkout code never
// changes what live customers see.
//
// When OFF (default):
//   • StickyBottomBar → Approve behaves as today (records approval → routes to
//     the booked page; no embedded card form).
//   • approve route   → sends the "we'll reach out to collect your deposit"
//     customer SMS/email (the pre-Valor placeholder messaging).
// When ON:
//   • StickyBottomBar → Approve opens the embedded 50% deposit checkout.
//   • approve route   → sends NO customer message (the receipt fires from the
//     Valor payment-confirmed webhook instead).
//
// NEXT_PUBLIC_ so the SAME value is readable in the browser (StickyBottomBar)
// and on the server (approve route). NOTE: NEXT_PUBLIC_ vars are inlined into
// the client bundle at BUILD time, so flipping this requires a REDEPLOY to take
// effect on the client — not just an env-var change.
export function isValorCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VALOR_CHECKOUT_ENABLED === 'true';
}
