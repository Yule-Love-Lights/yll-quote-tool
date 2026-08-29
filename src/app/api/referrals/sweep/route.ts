// Referral link sweep cron (naldo/referral-link-sweep). Vercel Cron hits this
// GET on the vercel.json schedule; it runs src/lib/referralSweep.ts's
// runReferralSweep, which pages GHL contacts, skips suppressed/already-done
// ones, and for the rest mints a referral code, stamps the
// {{contact.referral_link}} merge field, and tags exactly one of
// neighbor/has-referral-link. CRON-ONLY: requires
// Authorization: Bearer ${CRON_SECRET}. Dormant (200, no work) until
// HighLevel is configured.
//
// SAFETY: this route defaults to DRY RUN, same as runReferralSweep itself.
// Going live needs an EXPLICIT, deliberate signal, either one works (OR,
// not AND, so there is never a contradictory state):
//   - REFERRAL_SWEEP_LIVE=true set in the Vercel project's env vars: the
//     switch the SCHEDULED cron itself relies on. Unset (the default on any
//     fresh deploy), the cron previews forever and writes nothing, the same
//     "dormant until configured" posture as CRON_SECRET itself. This is the
//     one Naldo/Jason flip in the Vercel dashboard once they've watched a
//     few dry-run summaries and are ready for it to actually mint/stamp/tag.
//   - `?live=true` on the request itself: a manual override for an
//     operator testing with the real CRON_SECRET by hand, without touching
//     the standing env var.
// vercel.json's cron entry for this path carries NO query string on
// purpose: whether Vercel Cron even supports one isn't something this repo
// has ever relied on, so the env var is the one mechanism the actual
// schedule depends on. A bare authorized hit with neither set always
// previews, never writes. That is the "otherwise impossible to trigger a
// live run by accident" requirement, satisfied.
//
// maxDuration: this is the first cron in the repo that fans out N GHL calls
// per item it processes (up to ~7 in the worst case per contact, see
// referralSweep.ts) rather than a handful of calls total, so it gets its own
// generous ceiling. runReferralSweep's own internal time budget
// (DEFAULT_TIME_BUDGET_MS, 50s) stops the sweep well before this limit, so
// the platform should never actually need to kill the invocation.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { runReferralSweep, type ReferralSweepSummary } from '@/lib/referralSweep';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Mirrors src/app/api/ops/vehicle-poll/route.ts's own logging: Vercel Cron
 *  discards response bodies, so a summary that only lives in the JSON
 *  response is computed and thrown away on every scheduled run. This is the
 *  only place a human ever sees what a run actually did.
 *
 *  DRY RUN and LIVE are labeled up front so nobody has to squint at a log
 *  line to tell whether anything was actually written; an errored run logs
 *  via console.error (with the real error samples attached) instead of
 *  console.info so it stands out from a routine run.
 *
 *  Note: ReferralSweepSummary has no single "would be minted" field. A dry
 *  run never calls ensureReferralCode, so the closest real number is
 *  wouldTagNeighbor + wouldTagHasReferralLink: every contact that clears
 *  the same alreadyDone/suppressed gate a live run uses is one that would
 *  go on to be minted, stamped, and tagged. That sum is logged below as
 *  `wouldMint`, a label for this line only, not a field on the type. */
function logSweepSummary(summary: ReferralSweepSummary): void {
  const mode = summary.dryRun ? 'DRY RUN' : 'LIVE';
  const stageId = summary.resolvedDoNotCallStageId ?? '(unresolved)';

  if (!summary.ok) {
    console.error(
      `[referral-sweep] ${mode} ABORTED: ${summary.error ?? 'unknown error'} ` +
        `(scanned ${summary.scanned}, doNotCallStageId ${stageId})`,
    );
    return;
  }

  const mintedPart = summary.dryRun
    ? `wouldMint ${summary.wouldTagNeighbor + summary.wouldTagHasReferralLink} ` +
      `(neighbor ${summary.wouldTagNeighbor}, has-referral-link ${summary.wouldTagHasReferralLink})`
    : `minted ${summary.minted} (neighbor ${summary.taggedNeighbor}, has-referral-link ${summary.taggedHasReferralLink})`;

  const line =
    `[referral-sweep] ${mode}: scanned ${summary.scanned}, suppressed ${summary.suppressed}, ` +
    `alreadyDone ${summary.alreadyDone}, ${mintedPart}, errors ${summary.errors}, ` +
    `doNotCallStageId ${stageId}`;

  if (summary.errors > 0) console.error(line, summary.errorSamples);
  else console.info(line);
}

export async function GET(req: NextRequest) {
  // Shared guard: 503 (naming the variable) when CRON_SECRET is unset, 401 when
  // the token is merely wrong. See src/lib/auth/cronAuth.ts for why.
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  if (!isHighLevelConfigured()) {
    // See logSweepSummary's own comment: Vercel Cron discards response
    // bodies, so this silent 200 used to be indistinguishable from a live
    // cron nobody ever finished configuring. Logged so that's no longer true.
    console.info('[referral-sweep] dormant: HighLevel not configured, nothing scanned');
    return NextResponse.json({ ok: true, skipped: 'highlevel not configured' });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  // dryRun stays true unless the standing env var or the request query param
  // EXACTLY says otherwise. See this file's header for why there are two
  // ways in and why that's still unambiguous (OR, not AND).
  const live = process.env.REFERRAL_SWEEP_LIVE === 'true' || req.nextUrl.searchParams.get('live') === 'true';
  const summary = await runReferralSweep({ dryRun: !live });
  logSweepSummary(summary);
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
