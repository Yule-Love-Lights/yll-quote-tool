// Single source of truth for the #38 customer-facing deposit-checkout feature
// flag. Read on the SERVER at request time — the portal page passes the result
// to StickyBottomBar as a prop, and the approve route reads it directly. That
// avoids the build-time inlining gotcha a NEXT_PUBLIC_ client read would have
// (those bake into the browser bundle, so a cache-reused redeploy keeps the old
// value). As a runtime server read, flipping the env var just needs a redeploy.
//
// Accepts EITHER `VALOR_CHECKOUT_ENABLED` or the `NEXT_PUBLIC_` variant, so an
// already-set `NEXT_PUBLIC_VALOR_CHECKOUT_ENABLED=true` keeps working (read here
// at runtime on the server). Value parsing is tolerant — case-insensitive and
// trimmed, accepting true/1/yes/on — so a `True`/` true `/`1` in the dashboard
// still enables it (a common footgun with a strict `=== 'true'` check).
//
// When OFF (default): Approve → booked page; the approve route sends the "we'll
// reach out to collect your deposit" placeholder messaging.
// When ON: Approve → embedded deposit checkout; the receipt fires from the Valor
// payment-confirmed webhook instead.

const FLAG_ENV_NAMES = ['VALOR_CHECKOUT_ENABLED', 'NEXT_PUBLIC_VALOR_CHECKOUT_ENABLED'] as const;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export function isValorCheckoutEnabled(): boolean {
  return FLAG_ENV_NAMES.some((name) => truthy(process.env[name]));
}

// Diagnostic helper (no secret exposure): whether EITHER flag var is present at
// all in this environment, regardless of value. Lets a health check distinguish
// "var not reaching this deployment" (wrong env scope) from "present but value
// not truthy". Used by the webhook GET diagnostic.
export function isValorCheckoutFlagPresent(): boolean {
  return FLAG_ENV_NAMES.some((name) => process.env[name] != null && process.env[name] !== '');
}
