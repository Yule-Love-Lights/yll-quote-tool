// Feature flag for the self-serve referral link request page + API
// (naldo/referral-self-serve): GET /referral-link and POST
// /api/referrals/request-link.
//
// Ships OFF. Reverting the PR stops new writes but leaves already-created
// customers rows, referral codes, sent emails, and GHL Brand Ambassador
// stamps in place, so this flag is the actual rollback lever: flipping it
// off makes the feature genuinely inert (a 404 before any GHL or Supabase
// call is reachable), no redeploy-of-old-code required.
//
// Strict `=== 'true'` (mirrors src/lib/referralAutoAnalyze.ts's
// isReferralAutoAnalyzeEnabled, its closer sibling: another public,
// unauthenticated referral-page feature flag), not the tolerant
// true/1/yes/on parsing in src/lib/selfServe/estimateFlag.ts.
//
// Read on the SERVER at request time (never NEXT_PUBLIC, which bakes into
// the client bundle and survives a cache-reused redeploy). Flipping the env
// var just needs a redeploy, not a code change.
export function isReferralSelfServeEnabled(): boolean {
  return process.env.REFERRAL_SELF_SERVE_ENABLED === 'true';
}
