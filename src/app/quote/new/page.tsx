import QuoteBuilder from '@/components/quote/QuoteBuilder';

// Blank-slate builder. The editing flavor lives at /quote/[id] (task #31);
// both render the same QuoteBuilder component. `?test=1` (ledger #93) opens the
// builder in TEST MODE so Calculate saves a fully-simulated test quote.
//
// Optional name/email/phone/address/serviceType params (#leads "Create quote"
// link, src/app/admin/leads) prefill the blank builder's initial state — see
// QuoteBuilder's `prefill` prop and applyPrefill in @/lib/quoteForm. Raw and
// unvalidated here; QuoteBuilder does the sanitizing.
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
  }>;
}) {
  const { test, name, email, phone, address, serviceType } = await searchParams;
  const prefill =
    name || email || phone || address || serviceType
      ? { name, email, phone, address, serviceType }
      : undefined;
  return <QuoteBuilder isTest={test === '1'} prefill={prefill} />;
}
