// Staff-editable "years with YLL" override (#178).
//
// POST /api/customers/[customerId]/tenure-years   (operator-only)
// Body: { manualYears: number[] }   — strict: a real array of integer years,
//   each within [MIN_TENURE_YEAR, current year]. FULL REPLACEMENT — the
//   client sends the whole desired list (add/remove happens client-side),
//   not a delta.
// Response: { ok: true, manualYears: number[] } | { error, code? }
//
// manual_years is unioned with the auto-derived year set (deposit-paid quotes
// + legacy-rebook rows) by src/lib/customerTenure.ts — this route only owns
// the manual half. Derived years aren't writable here; there's nothing to
// "remove" for them (they're evidence, not opinion).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { MIN_TENURE_YEAR } from '@/lib/customerTenure';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A real customer accrues at most a handful of tenure years; cap it so a
// malformed/abusive body can't push an unbounded array into the update.
const MAX_MANUAL_YEARS = 50;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { customerId } = await params;
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: 'Invalid customer id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const manualYears = (body as { manualYears?: unknown } | null)?.manualYears;
  if (!Array.isArray(manualYears)) {
    return NextResponse.json(
      { error: 'manualYears must be an array', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (manualYears.length > MAX_MANUAL_YEARS) {
    return NextResponse.json(
      { error: `manualYears must contain at most ${MAX_MANUAL_YEARS} years`, code: 'invalid-body' },
      { status: 400 },
    );
  }
  const currentYear = new Date().getUTCFullYear();
  const years = new Set<number>();
  for (const v of manualYears) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return NextResponse.json(
        { error: 'manualYears must contain only integer years', code: 'invalid-body' },
        { status: 400 },
      );
    }
    if (v < MIN_TENURE_YEAR || v > currentYear) {
      return NextResponse.json(
        { error: `manualYears must be between ${MIN_TENURE_YEAR} and ${currentYear}`, code: 'invalid-body' },
        { status: 400 },
      );
    }
    years.add(v);
  }

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('customers')
    .update({ manual_years: Array.from(years).sort((a, b) => a - b) })
    .eq('id', customerId)
    .select('id, manual_years')
    .maybeSingle<{ id: string; manual_years: number[] }>();

  if (error) {
    console.error('[api/customers/:customerId/tenure-years] update failed:', error);
    return NextResponse.json({ error: 'Failed to update this customer' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, manualYears: data.manual_years });
}
