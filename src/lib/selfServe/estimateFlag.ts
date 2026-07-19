// Single source of truth for the customer self-serve estimate feature flag
// (Phase A). Read on the SERVER at request time — the /estimate page reads it
// and 404s when off, and both /api/estimate endpoints 503 when off. Mirrors the
// valorCheckout flag pattern: a runtime server read (never NEXT_PUBLIC, which
// bakes into the browser bundle and survives a cache-reused redeploy), so
// flipping the env var just needs a redeploy.
//
// Ships OFF. The whole self-serve front door stays dark in production until this
// is set true — that is the slice-1 rollback lever (its replacement, once the
// flag is eventually deleted, is reverting the feature PR).
//
// Value parsing is tolerant — case-insensitive, trimmed, accepting
// true/1/yes/on — so a `True` / ` true ` / `1` typed into the Vercel dashboard
// still enables it (the common footgun with a strict `=== 'true'` check).

const FLAG_ENV_NAMES = ['SELF_SERVE_ESTIMATE_ENABLED', 'NEXT_PUBLIC_SELF_SERVE_ESTIMATE_ENABLED'] as const;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export function isSelfServeEstimateEnabled(): boolean {
  return FLAG_ENV_NAMES.some((name) => truthy(process.env[name]));
}
