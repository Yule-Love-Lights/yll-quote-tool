// Single source of truth for the #38 customer-facing deposit-checkout feature
// flag. Read on the SERVER at request time — the portal page passes the result
// to StickyBottomBar as a prop, and the approve route reads it directly. That
// avoids the build-time inlining gotcha a NEXT_PUBLIC_ client read would have
// (those bake into the browser bundle, so a cache-reused redeploy keeps the old
// value). As a runtime server read, flipping the env var just needs a redeploy.
//
// Accepts EITHER `VALOR_CHECKOUT_ENABLED` or the `NEXT_PUBLIC_` variant, so an
// already-set `NEXT_PUBLIC_VALOR_CHECKOUT_ENABLED=true` keeps working (read here
// at runtime on the server, not relied upon in the browser bundle).
//
// When OFF (default): Approve → booked page; the approve route sends the "we'll
// reach out to collect your deposit" placeholder messaging.
// When ON: Approve → embedded deposit checkout; the receipt fires from the Valor
// payment-confirmed webhook instead.
export function isValorCheckoutEnabled(): boolean {
  return (
    process.env.VALOR_CHECKOUT_ENABLED === 'true' ||
    process.env.NEXT_PUBLIC_VALOR_CHECKOUT_ENABLED === 'true'
  );
}
