// Customer DECLINE for the latest total-changing amendment on a booked order.
// Sibling of amend-consent/route.ts (same capability-token model — the quote
// UUID — same CAS-guarded write) but the customer says NO instead of signing.
//
// Ledger #83 follow-up, from a real live incident: staff added a $342.56
// wreath to a booked order, the customer got a notice with no way to decline
// it on the portal, and had to phone in. This endpoint records that refusal.
//
// What this endpoint deliberately does NOT do: it does NOT re-price the
// order or change the quote's lifecycle status. Staff priced the change in
// the builder; only staff can un-price it (a new amendment). This marks the
// latest amendment `consent: {status: 'declined', ...}` so blocksSettlement
// (src/lib/amend.ts) keeps blocking the balance exactly as hard as it did
// while pending — a decline is NOT consent, so it must never become
// collectable. See amend.ts's isAmendmentConsentPending/blocksSettlement doc
// comments for the full reasoning; this route does not re-derive it.
//
// FIX2 (review HIGH): it DOES, best-effort, re-sync the linked invoice (if
// the job was completed) — /amend already does this on every recorded
// amendment, but a decline used to leave the invoice frozen at the rejected
// figures. Combined with the operator override on the collection routes,
// that meant an operator could charge exactly the amount the customer
// refused. Shared logic with /amend — src/lib/quoteAmendInvoiceSync.ts.
//
// FIX5 (review HIGH): it also fires a best-effort staff alert. Before this,
// a decline wrote to the DB and returned JSON to the customer's OWN browser —
// nothing told staff. Direct precedent: the Valor webhook's card-declined
// staff alert (src/app/api/integrations/valor/webhook/route.ts) — same
// email-to-internal-contact shape (src/lib/integrations/quoteMessages.ts's
// amendmentDeclinedInternalEmail*).

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  isAmendmentConsentPending,
  latestConsentAmendment,
  requiresReconsent,
  type AmendmentTrailEntry,
} from '@/lib/amend';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob, type InvoicePricingInput } from '@/lib/invoices';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import { resyncInvoiceToAgreedTotal } from '@/lib/quoteAmendInvoiceSync';
import { sendEmail, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import {
  amendmentDeclinedInternalEmailSubject,
  amendmentDeclinedInternalEmailHtml,
} from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the staff-side amend reason cap (src/app/api/quotes/[id]/amend/route.ts)
// — this is the customer's own optional free text, capped the same way.
const MAX_REASON = 500;

type ApprovalSnapshot = {
  amendments?: AmendmentTrailEntry[];
  [key: string]: unknown;
};

type QuoteRow = {
  id: string;
  status: QuoteStatus | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  approval_snapshot: ApprovalSnapshot | null;
  // FIX2: the full pricing result + the actually-paid deposit — needed to
  // re-sync the linked invoice (resolveAgreedTotal + resyncInvoiceToAgreedTotal),
  // same fields amend/route.ts's own QuoteRow selects for the same reason.
  result: (InvoicePricingInput & { total: number }) | null;
  deposit_amount_usd: number | null;
  // FIX5: for the staff alert — who declined, which quote, and (is_test) so a
  // test quote never fires a real alert, matching every other outward
  // integration's test-safety convention in this codebase.
  customer_name: string | null;
  quote_number: number | null;
  is_test: boolean | null;
};

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip')?.trim() || null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const limited = rateLimitResponse(req, {
    bucket: 'quote-amend-decline',
    limit: 5,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { amendedAt?: unknown; reason?: unknown } = {};
  try {
    body = (await req.json()) as { amendedAt?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const amendedAt = typeof body.amendedAt === 'string' ? body.amendedAt : '';
  if (!amendedAt) {
    return NextResponse.json(
      { error: 'A valid amendment id is required', code: 'bad-decline' },
      { status: 400 },
    );
  }
  // The decline reason is OPTIONAL customer free text — unlike amend-consent's
  // signature, there is nothing required to make a decline valid.
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (rawReason.length > MAX_REASON) {
    return NextResponse.json(
      { error: `Reason must be ≤ ${MAX_REASON} characters`, code: 'bad-decline' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: readError } = await sb
    .from('quotes')
    .select(
      'id, status, quote_sent_at, customer_approved_at, deposit_paid_at, approval_snapshot, result, deposit_amount_usd, customer_name, quote_number, is_test',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (readError || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const lifecycle = deriveStatus({
    status: quote.status,
    quote_sent_at: quote.quote_sent_at,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
  });
  if (!quote.deposit_paid_at || lifecycle !== 'booked') {
    return NextResponse.json(
      { error: 'Only a live booked order can record amendment consent', code: 'not-booked' },
      { status: 409 },
    );
  }

  const snapshot = quote.approval_snapshot ?? {};
  const amendments = Array.isArray(snapshot.amendments) ? snapshot.amendments : [];
  const latest = latestConsentAmendment(amendments);
  if (!latest || latest.amended_at !== amendedAt) {
    return NextResponse.json(
      { error: 'This amendment is no longer the latest price change', code: 'stale-amendment' },
      { status: 409 },
    );
  }
  const consentIndex = amendments.lastIndexOf(latest);
  if (!requiresReconsent(latest)) {
    return NextResponse.json(
      { error: 'This amendment does not require customer consent', code: 'consent-not-required' },
      { status: 409 },
    );
  }
  // Already signed — declining now would silently discard a real signature.
  // Reject rather than overwrite; the customer's UI shouldn't offer this path
  // once accepted (the card renders read-only), so reaching it means a stale
  // tab or a replay, not a genuine change of mind.
  if (latest.consent?.status === 'accepted') {
    return NextResponse.json(
      { error: 'This amendment was already approved and signed', code: 'already-accepted' },
      { status: 409 },
    );
  }
  // Already declined — idempotent success (a retry/double-submit should not
  // 409), mirroring amend-consent's own alreadyConsented short-circuit.
  if (latest.consent?.status === 'declined') {
    return NextResponse.json({ ok: true, alreadyDeclined: true });
  }

  const declinedAt = new Date().toISOString();
  const declined: AmendmentTrailEntry = {
    ...latest,
    consent: {
      status: 'declined',
      declined_at: declinedAt,
      ip: clientIp(req),
      ...(rawReason ? { reason: rawReason } : {}),
    },
  };
  const nextSnapshot: ApprovalSnapshot = {
    ...snapshot,
    amendments: amendments.map((entry, index) => (index === consentIndex ? declined : entry)),
  };

  // Compare-and-swap the full jsonb snapshot — identical shape to amend-consent's
  // write (see that route's comment for why the snapshot is serialized explicitly
  // rather than passed as an object).
  const { data: updated, error: updateError } = await sb
    .from('quotes')
    .update({ approval_snapshot: nextSnapshot })
    .eq('id', id)
    .eq('approval_snapshot', JSON.stringify(snapshot))
    .select('id');
  if (updateError) {
    console.error('[api/quotes/:id/amend-decline] update failed:', updateError);
    return NextResponse.json({ error: 'Failed to record your response' }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'The amendment changed while you were responding. Refresh and try again.', code: 'concurrent-amendment' },
      { status: 409 },
    );
  }

  // FIX2 (review HIGH): re-sync the linked invoice (if the job was completed)
  // to the now-effective agreed total — resolveAgreedTotal on the JUST-WRITTEN
  // snapshot skips the entry we declined (FIX1), so this naturally resolves
  // back to whatever the customer last actually agreed to. Best-effort: the
  // decline is already recorded above; a sync failure here must never make
  // this endpoint report a failure back to the customer. getJobByQuote /
  // getInvoiceByJob already fail safe to null on a read error (same contract
  // /amend relies on), so no extra try/catch is needed beyond that.
  if (quote.result) {
    const job = await getJobByQuote(id);
    const invoice = job ? await getInvoiceByJob(job.id) : null;
    if (invoice && invoice.status !== 'cancelled') {
      const newTotal = resolveAgreedTotal(nextSnapshot, quote.result);
      await resyncInvoiceToAgreedTotal({
        jobId: job!.id,
        invoice,
        result: quote.result,
        depositPaid: quote.deposit_amount_usd ?? 0,
        newTotal,
        logPrefix: '[api/quotes/:id/amend-decline]',
        retiredReason: 'amend-decline-reopen',
      });
    }
  }

  // FIX5 (review HIGH): tell staff. Best-effort — the decline is already
  // recorded above; a failed/unconfigured alert must never fail this
  // response. Test-safe: a test quote never fires a real send (matches every
  // other outward integration in this codebase).
  if (!quote.is_test) {
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (isHighLevelConfigured() && internalContactId) {
      const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
      try {
        await sendEmail({
          contactId: internalContactId,
          subject: amendmentDeclinedInternalEmailSubject({
            customerName: quote.customer_name,
            quoteNumber: quote.quote_number,
            refusedTotalUsd: declined.new_total,
          }),
          html: amendmentDeclinedInternalEmailHtml({
            customerName: quote.customer_name,
            quoteNumber: quote.quote_number,
            previousTotalUsd: declined.previous_total,
            refusedTotalUsd: declined.new_total,
            deltaUsd: declined.delta,
            ...(rawReason ? { reason: rawReason } : {}),
            adminUrl: `${baseUrl}/admin/quotes/${id}`,
            portalUrl: `${baseUrl}/portal/${id}`,
          }),
          emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
        });
      } catch (err) {
        console.error(
          '[api/quotes/:id/amend-decline] staff decline alert failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    declinedAt,
    amendedAt,
    previousTotalUsd: latest.previous_total,
    // Confirms isAmendmentConsentPending(declined) === isAmendmentConsentPending(pending) —
    // a declined increase is still un-settleable (see amend.ts).
    stillBlocksSettlement: isAmendmentConsentPending(declined) && declined.delta > 0,
  });
}
