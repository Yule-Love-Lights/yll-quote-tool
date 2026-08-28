// The installment runner endpoint (ledger row 448).
//
//   GET  /api/ops/installment-run   — the cron leg (Bearer CRON_SECRET)
//   POST /api/ops/installment-run   — the operator leg, body { dryRun?: boolean }
//
// NOT SCHEDULED. `vercel.json` deliberately has no entry for this path (Jason's
// call 2026-08-28: dry-run first, no cron armed until he says so). It is
// allowlisted in `operatorGate` now rather than later so that arming it is one
// line of `vercel.json` and one Vercel flag — the S47 class of bug is a cron
// added without its allowlist entry, silently 401'd by the perimeter before its
// own CRON_SECRET check ever runs.
//
// WHAT MAKES A RUN LIVE. `runInstallments` charges only when `dryRun` is false,
// and this route refuses to pass false unless `INSTALLMENT_RUNNER_ENABLED` is
// on. Underneath, `chargeBalanceOnFile` refuses again unless
// `VALOR_AUTO_CHARGE_ENABLED` is on. So a dry run is the default in every
// direction: an operator must ASK for a live run, and both flags must be set.
//
// AUTH. A cron request carries `Authorization: Bearer <CRON_SECRET>` and no
// operator session; an operator request carries a session and no Authorization
// header. So: an Authorization header present means this is judged as a cron
// request (401/503 per `cronDenial`), and its absence means `requireOperator`
// decides. Neither path can be skipped — an unauthenticated request with no
// header falls to `requireOperator` and is denied there.

import { NextRequest, NextResponse } from 'next/server';
import { cronDenial } from '@/lib/auth/cronAuth';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isInstallmentRunnerEnabled, runInstallments, runSummaryMessage } from '@/lib/installmentRunner';
import { isAutoChargeEnabled } from '@/lib/integrations/valorBalance';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, requestedDryRun: boolean) {
  const authorization = req.headers.get('authorization');
  const denied = authorization ? cronDenial(authorization) : await requireOperator();
  if (denied) return denied;

  const runnerArmed = isInstallmentRunnerEnabled();
  const dryRun = requestedDryRun || !runnerArmed;

  const result = await runInstallments({ dryRun });
  if (!result.ok) {
    console.error('[api/ops/installment-run] run failed:', result.error);
    return NextResponse.json({ ok: false, error: result.error }, { status: 503 });
  }

  // Best-effort staff alert. A dry run that charged nothing produces no message
  // at all (runSummaryMessage returns null), so this is silent on a quiet day.
  const summary = runSummaryMessage(result);
  if (summary && !result.dryRun) {
    try {
      await notifyTelegramAudience('jobs', summary);
    } catch (err) {
      console.error('[api/ops/installment-run] staff alert failed:', err);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun: result.dryRun,
    // Say WHY a run was dry, so a run that quietly charged nothing can never be
    // mistaken for a run that was never armed.
    runnerArmed,
    autoChargeArmed: isAutoChargeEnabled(),
    today: result.today,
    decisions: result.decisions,
    outcomes: result.outcomes,
    summary,
  });
}

/** The cron leg. Always asks for a live run; the flags decide whether it is one. */
export async function GET(req: NextRequest) {
  return handle(req, false);
}

/** The operator leg. Dry by default — a live run must ask for it explicitly. */
export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const requestedDryRun = (body as { dryRun?: unknown } | null)?.dryRun !== false;
  return handle(req, requestedDryRun);
}
