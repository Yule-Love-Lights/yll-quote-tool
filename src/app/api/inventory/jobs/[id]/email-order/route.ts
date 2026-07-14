// src/app/api/inventory/jobs/[id]/email-order/route.ts
// POST → email a job's materials order to the internal staff/purchasing contact
// (HIGHLEVEL_INTERNAL_CONTACT_ID, the same inbox used for the #38 deposit alerts).
// Staff act on it / forward to the supplier. Reuses the Slice 2a/2d projection
// via getJobWorkOrder. Service-role + HighLevel required.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJobWorkOrder } from '@/lib/inventory/jobs';
import { isHighLevelConfigured, sendEmail } from '@/lib/integrations/highlevel';
import { orderEmailSubject, orderEmailHtml } from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!isHighLevelConfigured() || !internalContactId) {
    return NextResponse.json(
      { error: 'Order email not configured — needs HighLevel + HIGHLEVEL_INTERNAL_CONTACT_ID' },
      { status: 503 },
    );
  }

  const { id } = await params;
  const wo = await getJobWorkOrder(id);
  if (!wo) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  try {
    // Test Quote (ledger #93) — isTest never reached this email before, so a
    // test job's order looked like a real one to whoever opened the inbox.
    // Prefix the subject here (orderEmailSubject itself stays untouched) and
    // pass isTest through to orderEmailHtml for the in-body banner.
    const subject = wo.job.isTest
      ? `[TEST] ${orderEmailSubject(wo.job.jobNumber, wo.job.customerName)}`
      : orderEmailSubject(wo.job.jobNumber, wo.job.customerName);
    await sendEmail({
      contactId: internalContactId,
      subject,
      html: orderEmailHtml({
        jobNumber: wo.job.jobNumber,
        customerName: wo.job.customerName,
        address: wo.job.customerAddress,
        installDate: wo.job.installDate,
        materials: wo.materials.materials,
        unbound: wo.materials.unbound.map((u) => ({ label: u.label, qty: u.qty })),
        isTest: wo.job.isTest,
      }),
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/jobs/email-order] failed:', err);
    return NextResponse.json({ error: 'Failed to send order email' }, { status: 502 });
  }
}
