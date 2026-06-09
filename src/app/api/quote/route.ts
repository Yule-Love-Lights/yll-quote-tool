import { NextRequest, NextResponse } from 'next/server';
import { calculateQuote, QuoteInputs } from '@/lib/pricing/pricingEngine';
import { saveQuote, updateQuote, Customer } from '@/lib/quotes';
import { getDesign, isValidDesignId } from '@/lib/designs';
import { applyProjectionToInputs } from '@/lib/design/projectScene';

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_TAKEDOWNS = ['included', 'premium'];

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { customer, inputs, quoteId, designId } = body as Record<string, unknown>;

  // Testing mode: customer fields (name, address, phone, email) are all
  // optional. We still accept the customer object so future fields can be
  // added without a breaking change, but we don't require any value.
  if (customer !== undefined && customer !== null && typeof customer !== 'object') {
    return NextResponse.json({ error: 'customer must be an object if provided' }, { status: 400 });
  }

  if (!inputs || typeof inputs !== 'object') {
    return NextResponse.json({ error: 'Missing quote inputs' }, { status: 400 });
  }
  const q = inputs as Record<string, unknown>;

  const footageFields = ['santasFootage', 'gingerbreadFootage', 'winterWonderlandFootage'] as const;
  for (const f of footageFields) {
    if (!isNonNegNumber(q[f])) {
      return NextResponse.json({ error: `${f} must be a non-negative number` }, { status: 400 });
    }
  }
  const difficultyFields = ['santasDifficulty', 'gingerbreadDifficulty', 'winterWonderlandDifficulty'] as const;
  for (const f of difficultyFields) {
    if (!VALID_DIFFICULTIES.includes(q[f] as string)) {
      return NextResponse.json({ error: `Invalid ${f}` }, { status: 400 });
    }
  }

  if (!Array.isArray(q.miniLightItems) || !Array.isArray(q.spritzers) ||
      !Array.isArray(q.wreaths) || !Array.isArray(q.garland)) {
    return NextResponse.json({ error: 'miniLightItems, spritzers, wreaths, and garland must be arrays' }, { status: 400 });
  }
  if (q.customLineItems !== undefined && !Array.isArray(q.customLineItems)) {
    return NextResponse.json({ error: 'customLineItems must be an array if provided' }, { status: 400 });
  }
  if (!VALID_TAKEDOWNS.includes(q.takedown as string)) {
    return NextResponse.json({ error: 'Invalid takedown value' }, { status: 400 });
  }
  if (typeof q.rushFee !== 'boolean') {
    return NextResponse.json({ error: 'rushFee must be a boolean' }, { status: 400 });
  }

  try {
    let quoteInputs = inputs as QuoteInputs;
    // If a design is linked AND its scene has projectable per-unit items, the
    // DESIGN is the master list for those items (#27): replace the per-unit
    // inputs with the projection before pricing + saving. Roofline + custom
    // items + fees pass through. No design (or an empty/roofline-only design) =
    // the form's manual per-unit entry still drives the quote (decision 2a).
    if (isValidDesignId(designId)) {
      const design = await getDesign(designId);
      if (design?.scene) {
        quoteInputs = applyProjectionToInputs(quoteInputs, design.scene);
      }
    }
    const result = calculateQuote(quoteInputs);
    const safeCustomer = (customer ?? {}) as Customer;
    // A valid quoteId means re-price that existing quote in place (the
    // builder's "recommend roofline" toggle, #17) instead of inserting a new
    // row; otherwise save a fresh quote.
    const isUpdate = typeof quoteId === 'string' && /^[0-9a-f-]{36}$/i.test(quoteId);
    const saved = isUpdate
      ? await updateQuote(quoteId as string, quoteInputs, result)
      : await saveQuote(safeCustomer, quoteInputs, result);
    return NextResponse.json({
      customer: safeCustomer,
      result,
      quoteId: saved?.id ?? null,
      persisted: saved !== null,
    });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
