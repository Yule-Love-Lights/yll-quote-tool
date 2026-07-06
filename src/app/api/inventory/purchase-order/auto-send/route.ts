// src/app/api/inventory/purchase-order/auto-send/route.ts
// OPTIONAL unattended supplier ordering (#82 Phase 3). A Vercel Cron
// (vercel.json) fires every 3 days at 13:00 UTC and emails the current PO to the
// supplier WITHOUT a human click. There's ALSO an event-driven sibling — see
// triggerAutoPOIfBusy() called from the Valor deposit webhook (fires when a new
// deposit pushes active job count ≥ 5, per Naldo's "more than 4 installs" rule).
//
// SAFEGUARDS (auto-placing real orders is hard to reverse):
//   1. OFF by default — only runs when PO_AUTO_SEND_ENABLED='true'.
//   2. CRON-only — Vercel attaches `Authorization: Bearer ${CRON_SECRET}`; required.
//   3. DEDUP — never re-emails an UNCHANGED order (signature stored in app_settings);
//      resets when the shortfall clears so a re-appearing shortfall sends again.
// KNOWN LIMITATION (#110 W7-002, MITIGATED): there's no "on-order/received"
// ledger, so if the shortfall CHANGES before stock arrives, a re-send re-lists
// the full CUMULATIVE outstanding need (not the delta). The supplier email now
// states this order REPLACES any prior unshipped order (fulfill as the total, not
// additively), so a re-send can't cause double-shipping — the cumulative quantity
// IS the true remaining need. A proper delta-based on-order ledger (order only
// what isn't already en route) is future work (P8 inventory). The dedup + the
// human-gated /inventory/orders "Send" remain the safer fallbacks.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { safeEqual } from '@/lib/security';
import {
  buildSupplierPurchaseOrder,
  emailSupplierPurchaseOrder,
  purchaseOrderSignature,
  getLastAutoSentSignature,
  recordAutoSentSignature,
} from '@/lib/inventory/purchaseOrder';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.PO_AUTO_SEND_ENABLED !== 'true') {
    return NextResponse.json({ ok: true, enabled: false });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const po = await buildSupplierPurchaseOrder();
  if (!po.lines.length) {
    // Shortfall cleared — reset the dedup so the next real shortfall sends.
    await recordAutoSentSignature('');
    return NextResponse.json({ ok: true, sent: false, reason: 'nothing to order' });
  }

  const sig = purchaseOrderSignature(po.lines);
  if (sig === (await getLastAutoSentSignature())) {
    return NextResponse.json({ ok: true, sent: false, reason: 'unchanged since last send' });
  }

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const res = await emailSupplierPurchaseOrder(po, date);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  await recordAutoSentSignature(sig);
  return NextResponse.json({ ok: true, sent: true, items: po.lines.length });
}
