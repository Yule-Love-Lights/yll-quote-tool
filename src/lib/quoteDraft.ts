// Local draft autosave for the operator quote builder (quote-forms-partial-save).
//
// The QuoteBuilder is an INTERNAL staff tool, not a customer lead form — so
// unlike the website/referral forms it does NOT push a partial lead to GHL.
// "Save customer info even if they don't complete the form" here means: if an
// operator types a customer's name/phone/email/address into a brand-new quote
// and navigates away before hitting Calculate (which is the first thing that
// persists anything), don't lose it. We stash JUST the customer block +
// service type in localStorage and offer to restore it next time /quote/new
// opens blank. Scope is deliberately tiny: no design/scene/pricing state (that
// round-trips through the saved quote row once Calculate runs), and it's only
// ever active for a new, non-test quote.

import type { FormCustomer } from './quoteForm';
import type { ServiceType } from './serviceType';

const KEY = 'yll_quote_draft_v1';

export type QuoteDraft = {
  customer: FormCustomer;
  serviceType: ServiceType;
  savedAt: number;
};

function hasWindow(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function customerIsEmpty(c: FormCustomer): boolean {
  return !c.name.trim() && !c.phone.trim() && !c.email.trim() && !c.address.trim();
}

export function loadQuoteDraft(): QuoteDraft | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuoteDraft>;
    const c = parsed.customer;
    if (!c || typeof c !== 'object') return null;
    const customer: FormCustomer = {
      name: typeof c.name === 'string' ? c.name : '',
      phone: typeof c.phone === 'string' ? c.phone : '',
      email: typeof c.email === 'string' ? c.email : '',
      address: typeof c.address === 'string' ? c.address : '',
    };
    // A draft with nothing in the customer block is worthless — treat as absent.
    if (customerIsEmpty(customer)) return null;
    return {
      customer,
      serviceType: (parsed.serviceType as ServiceType) ?? 'holiday',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveQuoteDraft(customer: FormCustomer, serviceType: ServiceType): void {
  if (!hasWindow()) return;
  // Never persist an all-empty customer block (clear instead, below).
  if (customerIsEmpty(customer)) {
    clearQuoteDraft();
    return;
  }
  try {
    const draft: QuoteDraft = { customer, serviceType, savedAt: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* private mode / storage full — autosave is best-effort */
  }
}

export function clearQuoteDraft(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
