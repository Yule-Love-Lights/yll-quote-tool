// Installment plans for the admin list (Homeworks migration, 2026-08-28).
//
// GET /api/admin/installments   (operator-only)
// Response: { ok: true, plans: InstallmentPlan[] } | { error: string }
//
// READ-ONLY. Nothing here charges a card, sends a pay link, or messages a
// customer — see src/lib/installments.ts's header.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { listInstallmentPlans } from '@/lib/installments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;

  const res = await listInstallmentPlans();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  return NextResponse.json({ ok: true, plans: res.plans });
}
