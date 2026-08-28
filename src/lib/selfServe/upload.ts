// Customer self-serve estimate — "upload your own photo" path (ledger self-serve,
// S48). An uploaded photo can't feed the automatic measure+price pipeline (that
// needs the geocode + satellite scale), so this creates a self-serve DRAFT with the
// customer's photo attached as the design's base image, marked source
// 'self_serve_upload'. It lands in the staff dashboard like any draft; staff trace +
// price it by hand, then send it. The contact step then attaches who the customer is.

import { calculateQuote, BUSINESS_RULES, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { saveQuote } from '@/lib/quotes';
import { createDesign } from '@/lib/designs';

// A fully-zeroed holiday input set — no measurement yet (staff design by hand).
//
// Premerge technical lens, 2026-08-27: the roofline difficulties here are NOT
// inert just because footage is 0. They are stored EXPLICITLY, so when staff
// reopen this draft `inputsToFormData`'s `?? rooflineDefaultDifficulty` fallback
// never fires and the dropdown pre-selects whatever is written here — for
// exactly the "nobody decided this" reason the always-Easy rule exists. I had
// reasoned past this on the grounds that 0 ft × any rate is 0, which is true of
// the price at creation and false of the state on reopen.
export const EMPTY_HOLIDAY_INPUTS: QuoteInputs = {
  santasFootage: 0,
  santasDifficulty: BUSINESS_RULES.rooflineDefaultDifficulty,
  gingerbreadFootage: 0,
  gingerbreadDifficulty: BUSINESS_RULES.rooflineDefaultDifficulty,
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0,
  stakeLightingDifficulty: 'medium',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};

/**
 * Create a self-serve draft from a customer-uploaded home photo. Returns the new
 * quote id (so the contact step can attach the customer), or null on failure. The
 * design photo is best-effort — a save that keeps the quote but loses the picture
 * is better than dropping the lead entirely.
 */
export async function createUploadQuote(
  photoBase64: string,
  photoMediaType: string,
  address: string | null,
): Promise<string | null> {
  const priced = calculateQuote(EMPTY_HOLIDAY_INPUTS);
  const inputsWithMeta = {
    ...EMPTY_HOLIDAY_INPUTS,
    meta: { source: 'self_serve_upload' },
  } as QuoteInputs;
  const saved = await saveQuote({ address: address ?? undefined }, inputsWithMeta, priced, 'holiday');
  const quoteId = saved?.id ?? null;
  if (!quoteId) return null;
  try {
    await createDesign({ quoteId, photoBase64, photoMediaType });
  } catch (err) {
    console.error('[selfServe/upload] createDesign failed (quote kept):', err instanceof Error ? err.message : 'error');
  }
  return quoteId;
}
