// Installment plans for the admin list (Homeworks migration, 2026-08-28).
//
// GET /api/admin/installments   (operator-only)
// Response: { ok: true, plans: InstallmentPlan[],
//              autoCharge: { runnerArmed, valorArmed } } | { error: string }
//
// The autoCharge flags are REPORTED, never acted on here: they say whether the
// runner (ledger row 448) would charge if it ran, which is otherwise visible
// only in Vercel's env-var screen.
//
// READ-ONLY. Nothing here charges a card, sends a pay link, or messages a
// customer — see src/lib/installments.ts's header.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { listInstallmentPlans } from '@/lib/installments';
import { isInstallmentRunnerEnabled } from '@/lib/installmentRunner';
import { isAutoChargeEnabled } from '@/lib/integrations/valorBalance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;

  const res = await listInstallmentPlans();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  // Row 448 premerge (admin lens MED): whether the automation is switched on
  // lived only in Vercel's env-var screen, so the owner had no way to look at
  // the app and know. Both flags, reported where the plans are.
  return NextResponse.json({
    ok: true,
    plans: res.plans,
    autoCharge: { runnerArmed: isInstallmentRunnerEnabled(), valorArmed: isAutoChargeEnabled() },
  });
}
