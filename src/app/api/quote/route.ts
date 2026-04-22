import { NextRequest, NextResponse } from 'next/server';
import { calculateQuote, QuoteInputs } from '@/lib/pricing/pricingEngine';
import { saveQuote, Customer } from '@/lib/quotes';

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

  const { customer, inputs } = body as Record<string, unknown>;

  if (!customer || typeof customer !== 'object') {
    return NextResponse.json({ error: 'Missing customer info' }, { status: 400 });
  }
  const c = customer as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name.trim() ||
      typeof c.address !== 'string' || !c.address.trim()) {
    return NextResponse.json({ error: 'Customer name and address are required' }, { status: 400 });
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
  if (!VALID_TAKEDOWNS.includes(q.takedown as string)) {
    return NextResponse.json({ error: 'Invalid takedown value' }, { status: 400 });
  }
  if (typeof q.rushFee !== 'boolean') {
    return NextResponse.json({ error: 'rushFee must be a boolean' }, { status: 400 });
  }

  try {
    const quoteInputs = inputs as QuoteInputs;
    const result = calculateQuote(quoteInputs);
    const saved = await saveQuote(customer as Customer, quoteInputs, result);
    return NextResponse.json({
      customer,
      result,
      quoteId: saved?.id ?? null,
      persisted: saved !== null,
    });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
