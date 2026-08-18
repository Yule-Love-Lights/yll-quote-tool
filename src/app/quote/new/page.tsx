import QuoteBuilder from '@/components/quote/QuoteBuilder';
import { getCustomerByHlContactId } from '@/lib/customers';

// Blank-slate builder. The editing flavor lives at /quote/[id] (task #31);
// both render the same QuoteBuilder component. `?test=1` (ledger #93) opens the
// builder in TEST MODE so Calculate saves a fully-simulated test quote.
//
// Optional name/email/phone/address/serviceType/ghlContactId params (#leads
// "Create quote" link, src/app/admin/leads) prefill the blank builder's
// initial state — see QuoteBuilder's `prefill` prop and applyPrefill in
// @/lib/quoteForm. Raw and unvalidated here; QuoteBuilder does the sanitizing.
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{
    test?: string;
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    serviceType?: string;
    ghlContactId?: string;
  }>;
}) {
  const { test, name, email, phone, address, serviceType, ghlContactId } = await searchParams;

  // NCE + YLL Neighbor tag inheritance (#198): a lead-created quote whose
  // contact already maps to a tagged customer starts tagged too. Server-side
  // (this is an async server component) so QuoteBuilder's prefill carries a
  // real resolved boolean, not another URL string to re-fetch client-side.
  // Read-only lookup (never creates a row) — just viewing this page with a
  // ?ghlContactId= must not conjure a customer.
  const trimmedGhlContactId = ghlContactId?.trim();
  const taggedCustomer = trimmedGhlContactId
    ? await getCustomerByHlContactId(trimmedGhlContactId)
    : null;

  const prefill =
    name || email || phone || address || serviceType || ghlContactId
      ? {
          name,
          email,
          phone,
          address,
          serviceType,
          ghlContactId,
          isNce: taggedCustomer?.is_nce ?? undefined,
          legacyRebook: taggedCustomer?.is_yll_neighbor ?? undefined,
        }
      : undefined;
  return <QuoteBuilder isTest={test === '1'} prefill={prefill} />;
}
