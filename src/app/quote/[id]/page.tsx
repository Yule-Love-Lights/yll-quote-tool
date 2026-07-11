import { notFound } from 'next/navigation';
import QuoteBuilder from '@/components/quote/QuoteBuilder';
import { getQuoteRaw } from '@/lib/quotes';
import { getDesignByQuote } from '@/lib/designs';
import { isValidQuoteId } from '@/lib/portal/loader';
import { refereeReferralFor } from '@/lib/referrals';

// Edit an existing quote (task #31): reopen a saved quote in the builder with
// its inputs hydrated and its linked design (if any) mounted in the design
// section. Server component — the row + design link load here directly (no
// public API exposes the raw inputs). /quote/new wins over this dynamic
// segment, so the create flow is unaffected.

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidQuoteId(id)) notFound();

  const quote = await getQuoteRaw(id);
  if (!quote) notFound();

  // The design linked to this quote, if one exists. Only the id is needed —
  // the editor loads the scene + photo itself via /api/designs/[id].
  const design = await getDesignByQuote(id);

  // Referral program redemption (#41 PR 2): resolve server-side whether this
  // quote is a referee (a referrals row exists with it as referee_quote_id),
  // regardless of status — the client-side "Referred by" picker state only
  // exists in the session that originally picked it, so a reopened quote
  // needs this to show the spritzer banner again. Best-effort (refereeReferralFor
  // already fails open internally on a missing/unconfigured Supabase).
  const referee = await refereeReferralFor(quote.id);

  return (
    <QuoteBuilder
      initialQuote={{
        quoteId: quote.id,
        customerId: quote.customer_id,
        isReferee: referee != null,
        customer: {
          name: quote.customer_name,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
        },
        serviceType: quote.service_type,
        inputs: quote.inputs ?? {},
        result: quote.result,
        designId: design?.id ?? null,
        sentAt: quote.quote_sent_at,
        approvedAt: quote.customer_approved_at,
        // Canonical status + display number for the header pill/ID (BUG-1/BUG-2,
        // S22): getQuoteRaw already selects these. deriveStatus in the builder
        // prefers a persisted declined/cancelled over the timestamps.
        status: quote.status,
        viewedAt: quote.viewed_at,
        depositPaidAt: quote.deposit_paid_at,
        quoteNumber: quote.quote_number,
        // Reopened test quote stays in TEST MODE (ledger #93) — from the saved
        // row, not the URL (is_test is immutable once set).
        isTest: quote.is_test,
      }}
    />
  );
}
