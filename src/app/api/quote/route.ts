import { NextRequest, NextResponse } from 'next/server';
import { calculateQuote, QuoteInputs } from '@/lib/pricing/pricingEngine';

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_PACKAGES = ['santas', 'gingerbread', 'winterWonderland'];
const VALID_TAKEDOWNS = ['included', 'premium'];

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

  // Customer validation
  if (!customer || typeof customer !== 'object') {
    return NextResponse.json({ error: 'Missing customer info' }, { status: 400 });
  }
  const c = customer as Record<string, unknown>;
  if (!c.name || !c.address) {
    return NextResponse.json({ error: 'Customer name and address are required' }, { status: 400 });
  }

  // Inputs shape validation
  if (!inputs || typeof inputs !== 'object') {
    return NextResponse.json({ error: 'Missing quote inputs' }, { status: 400 });
  }
  const q = inputs as Record<string, unknown>;

  if (typeof q.rooflineFootage !== 'number' || q.rooflineFootage < 0) {
    return NextResponse.json({ error: 'rooflineFootage must be a non-negative number' }, { status: 400 });
  }
  if (!VALID_DIFFICULTIES.includes(q.rooflineDifficulty as string)) {
    return NextResponse.json({ error: 'Invalid rooflineDifficulty' }, { status: 400 });
  }
  if (!VALID_PACKAGES.includes(q.rooflinePackage as string)) {
    return NextResponse.json({ error: 'Invalid rooflinePackage' }, { status: 400 });
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
    const result = calculateQuote(inputs as QuoteInputs);
    return NextResponse.json({ customer, result });
  } catch (err) {
    console.error('Quote calculation error:', err);
    return NextResponse.json({ error: 'Failed to calculate quote' }, { status: 500 });
  }
}
