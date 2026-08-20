import QuoteBuilder from '@/components/quote/QuoteBuilder';
import { getCustomerByHlContactId } from '@/lib/customers';
import { asServiceType, canCarryNceOrYllNeighborTag, DEFAULT_SERVICE_TYPE } from '@/lib/serviceType';

// #243 (domain rule locked 2026-08-11): PURE seam so the tag-inheritance gate
// is unit-testable — no component-render test infra exists in this repo for
// an async server component (see pay-balance/page.test.ts's own note; same
// extraction pattern). Resolves serviceType and isNce/legacyRebook the SAME
// way NewQuotePage's own prefill object below always has (independently, per
// their own #243 recon note) — but now gated: a tagged customer's tags only
// carry onto the prefill when the RESOLVED service type (the raw URL param,
// defaulting to holiday exactly like applyPrefill/initialFormData do) can
// carry them. canCarryNceOrYllNeighborTag (serviceType.ts) is the single
// source of truth every set/inherit site shares.
export function resolvePrefillTags(
  rawServiceType: string | undefined,
  taggedCustomer: { is_nce?: boolean | null; is_yll_neighbor?: boolean | null } | null,
): { isNce?: boolean; legacyRebook?: boolean } {
  const effectiveServiceType = asServiceType(rawServiceType) ?? DEFAULT_SERVICE_TYPE;
  if (!canCarryNceOrYllNeighborTag(effectiveServiceType)) return {};
  return {
    isNce: taggedCustomer?.is_nce ?? undefined,
    legacyRebook: taggedCustomer?.is_yll_neighbor ?? undefined,
  };
}

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
  //
  // #243: resolvePrefillTags above gates this on the RESOLVED serviceType —
  // pre-#243, serviceType and isNce/legacyRebook were resolved completely
  // independently, so ?serviceType=permanent&ghlContactId=<nce customer>
  // prefilled isNce:true on a quote that can never legally carry it.
  const trimmedGhlContactId = ghlContactId?.trim();
  const taggedCustomer = trimmedGhlContactId
    ? await getCustomerByHlContactId(trimmedGhlContactId)
    : null;
  const prefillTags = resolvePrefillTags(serviceType, taggedCustomer);

  const prefill =
    name || email || phone || address || serviceType || ghlContactId
      ? {
          name,
          email,
          phone,
          address,
          serviceType,
          ghlContactId,
          ...prefillTags,
        }
      : undefined;
  return <QuoteBuilder isTest={test === '1'} prefill={prefill} />;
}
