// POST /api/quotes/[id]/send-balance  (operator-only)
//
// Staff-initiated: text/email the customer their remaining-balance pay-link
// (/portal/[quoteId]/pay-balance) once a job is complete (ledger #83). This only
// SENDS a message — no money moves, no stage change, no booking. The customer
// pays the balance on Valor's hosted page via the existing pay-balance route.
//
// #199: an NCE-tagged quote's balance is never collectable by pay-link (it
// settles through NCE) — 409s before any job/invoice lookup or GHL send, no
// override (unlike charge-balance's overrideNce — there is no "send it
// anyway" here; the pay-link itself would just dead-end at the portal's own
// #199 block).
//
// Body: { channel?: 'email' | 'sms' | 'both' }  (default 'both')
// Response: { ok, smsSent, emailSent, messageError?, channel, balanceUsd } | { error, code? }

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';
import {
  isHighLevelConfigured,
  sendSms,
  sendEmail,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  BALANCE_LINK_EMAIL_SUBJECT,
  balanceLinkSmsBody,
  balanceLinkEmailHtml,
} from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = {
  id: string;
  highlevel_contact_id: string | null;
  customer_name: string | null;
  is_test: boolean;
  is_nce: boolean;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-send-balance', limit: 20, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  // Channel split, mirroring /send: { channel?: 'email' | 'sms' | 'both' }.
  let body: { channel?: unknown } = {};
  try {
    body = (await req.json()) as { channel?: unknown };
  } catch {
    body = {};
  }
  const channel =
    body.channel === 'sms' || body.channel === 'email' || body.channel === 'both' ? body.channel : 'both';
  const doSms = channel === 'both' || channel === 'sms';
  const doEmail = channel === 'both' || channel === 'email';

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_contact_id, customer_name, is_test, is_nce')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  if (quote.is_test) {
    return NextResponse.json({ error: 'Test quote — no real balance to collect', code: 'test-quote' }, { status: 400 });
  }
  // #199: an NCE trade job's balance is not collectable by pay-link — never
  // send it, checked before any job/invoice lookup or GHL send.
  if (quote.is_nce) {
    return NextResponse.json(
      {
        error: 'This is an NCE trade job — the balance is not collectable by pay-link. The link was NOT sent.',
        code: 'nce-blocked',
      },
      { status: 409 },
    );
  }

  // The balance lives on the invoice (created when the job is completed).
  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  if (!invoice) {
    return NextResponse.json({ error: 'No invoice for this order yet', code: 'no-invoice' }, { status: 409 });
  }
  if (invoice.status === 'cancelled') {
    return NextResponse.json({ error: 'This invoice was cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (invoice.status === 'paid' || invoice.balance <= 0) {
    return NextResponse.json({ error: 'No balance due', code: 'no-balance' }, { status: 409 });
  }

  if (!quote.highlevel_contact_id) {
    return NextResponse.json(
      { error: 'This customer has no linked contact to message', code: 'no-contact' },
      { status: 409 },
    );
  }

  const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
  const payUrl = `${baseUrl}/portal/${id}/pay-balance`;
  const phone = process.env.HIGHLEVEL_SMS_FROM_NUMBER || '(631) 517-0186';
  const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
  const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;

  let smsSent = false;
  let emailSent = false;
  let messageError: string | undefined;

  if (!isHighLevelConfigured()) {
    return NextResponse.json(
      { error: 'Messaging is not configured yet', code: 'ghl-not-configured' },
      { status: 503 },
    );
  }

  if (doSms) {
    try {
      await sendSms({
        contactId: quote.highlevel_contact_id,
        message: balanceLinkSmsBody(firstName, invoice.balance, payUrl, phone),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send-balance] SMS send failed:', err);
      messageError = hlErrorMessage(err);
    }
  }
  if (doEmail) {
    try {
      await sendEmail({
        contactId: quote.highlevel_contact_id,
        subject: BALANCE_LINK_EMAIL_SUBJECT,
        html: balanceLinkEmailHtml({ firstName, balanceUsd: invoice.balance, payUrl, phone }),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send-balance] Email send failed:', err);
      messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
    }
  }

  return NextResponse.json({ ok: true, smsSent, emailSent, messageError, channel, balanceUsd: invoice.balance });
}
