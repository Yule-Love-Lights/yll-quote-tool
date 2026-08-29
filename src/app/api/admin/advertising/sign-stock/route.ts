import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSignStock, setSignStockQty, SignStockConflictError } from '@/lib/advertising/signStock';

export const runtime = 'nodejs';

/**
 * Yard-sign stock (advertising phase 2 — manual reconciliation only).
 *
 *   GET   /api/admin/advertising/sign-stock — on-hand count beside the
 *         accepted / pending placement counts
 *   PATCH /api/admin/advertising/sign-stock — { onHandQty }: the number the
 *         admin just counted. Audited with prior and new; nothing here (or
 *         anywhere) auto-decrements on acceptance — that is the phase gate.
 */

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ stock: await getSignStock() });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as { onHandQty?: unknown } | null;
  const qty = body?.onHandQty;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0) {
    return NextResponse.json(
      { error: 'Send onHandQty as a whole number, 0 or more.' },
      { status: 400 },
    );
  }

  try {
    const stock = await setSignStockQty(qty, auth.operator.id);
    return NextResponse.json({ stock });
  } catch (e) {
    if (e instanceof SignStockConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('PATCH /api/admin/advertising/sign-stock:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not save the count. Try again.' }, { status: 500 });
  }
}
