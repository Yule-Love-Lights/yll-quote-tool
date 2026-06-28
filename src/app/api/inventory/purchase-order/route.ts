// src/app/api/inventory/purchase-order/route.ts
// Supplier purchase order (#82 Phase 3 auto-ordering, email channel).
//   GET  → preview the auto-generated PO (shortfall across booked jobs vs on-hand).
//   POST → email it to the supplier (Thunder) — HUMAN-GATED (staff trigger this;
//          there is no unattended auto-send). Needs HighLevel + a supplier GHL
//          contact (THUNDER_ORDER_CONTACT_ID). Service-role only.

import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { buildSupplierPurchaseOrder } from '@/lib/inventory/purchaseOrder';
import { isHighLevelConfigured, sendEmail } from '@/lib/integrations/highlevel';
import { supplierOrderEmailSubject, supplierOrderEmailHtml } from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await buildSupplierPurchaseOrder());
  } catch (err) {
    console.error('[api/inventory/purchase-order] GET failed:', err);
    return NextResponse.json({ error: 'Failed to build purchase order' }, { status: 500 });
  }
}

export async function POST() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const supplierContactId = process.env.THUNDER_ORDER_CONTACT_ID;
  if (!isHighLevelConfigured() || !supplierContactId) {
    return NextResponse.json(
      { error: 'Supplier order email not configured — needs HighLevel + THUNDER_ORDER_CONTACT_ID (a GHL contact for the supplier)' },
      { status: 503 },
    );
  }

  const po = await buildSupplierPurchaseOrder();
  if (!po.lines.length) {
    return NextResponse.json({ error: 'Nothing to order — on-hand covers all booked jobs.' }, { status: 400 });
  }

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  try {
    await sendEmail({
      contactId: supplierContactId,
      subject: supplierOrderEmailSubject(po.jobCount, date),
      html: supplierOrderEmailHtml({
        lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, order: l.order })),
        jobCount: po.jobCount,
        date,
      }),
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    return NextResponse.json({ ok: true, sent: po.lines.length });
  } catch (err) {
    console.error('[api/inventory/purchase-order] POST failed:', err);
    return NextResponse.json({ error: 'Failed to send the order email' }, { status: 502 });
  }
}
