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
import { runReferralSweep } from '@/lib/referralSweep';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Shared guard: 503 (naming the variable) when CRON_SECRET is unset, 401 when
  // the token is merely wrong. See src/lib/auth/cronAuth.ts for why.
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  if (!isHighLevelConfigured()) {
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
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
