// A staff member's PAY RATE HISTORY — ledger row 506. ADMIN ONLY: this
// decides what somebody's hours are worth, so it is payroll, not settings.
//
// POST   { crewMemberId, hourlyRate, effectiveFrom }  → set the rate from that ET day
// DELETE { crewMemberId, rateId }                     → remove one rate row
//
// `hourlyRate` is a STRING an admin typed, parsed server-side by the same
// `dollarsToCents` the staff panel uses, so "16", "16.50" and "$16.50" all
// mean what they look like and 0.1 * 100 never enters it.
//
// `effectiveFrom` is an ET CALENDAR DAY (`YYYY-MM-DD`), not a timestamp: a
// rate changes on a day. A day in the PAST is the normal case rather than an
// edge one — it is how a real history gets entered at all — and it cannot
// rewrite a payment already recorded, because every settlement line carries
// the rate it was paid at, stamped at the time.

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { RateRefusedError, deleteRate, setRateFrom } from '@/lib/crewMemberRates';
import { dollarsToCents } from '@/lib/hourlyRate';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const REFUSAL_STATUS: Record<RateRefusedError['reason'], number> = {
  'invalid-rate': 400,
  'invalid-date': 400,
  'not-found': 404,
  // Well-formed, and refused because of what the record currently is: the
  // only rate on file cannot be the one you remove.
  'last-rate': 409,
};

/** Name plus email, the same stamp `shifts.manual_by` and `paid_by` carry, so
 * every identity on a payroll screen reads alike and survives a rename. */
function gateActor(operator: { name: string | null; email: string | null }): string {
  const name = operator.name?.trim();
  const email = operator.email?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || 'admin';
}

function refusalResponse(err: unknown): NextResponse | null {
  if (err instanceof RateRefusedError) {
    return NextResponse.json(
      { error: err.message, code: err.reason },
      { status: REFUSAL_STATUS[err.reason] },
    );
  }
  return null;
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;
  const { operator } = gate;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { crewMemberId, hourlyRate, effectiveFrom } = (body as {
    crewMemberId?: unknown;
    hourlyRate?: unknown;
    effectiveFrom?: unknown;
  } | null) ?? {};

  if (typeof crewMemberId !== 'string' || !crewMemberId.trim()) {
    return NextResponse.json(
      { error: 'crewMemberId is required', code: 'invalid-body' },
      { status: 400 },
    );
  }
  const rateCents = dollarsToCents(hourlyRate);
  if (rateCents === null || rateCents <= 0) {
    return NextResponse.json(
      { error: 'Enter an hourly rate greater than zero, like 16.00.', code: 'invalid-rate' },
      { status: 400 },
    );
  }
  if (typeof effectiveFrom !== 'string') {
    return NextResponse.json(
      { error: 'Pick the date the rate started.', code: 'invalid-date' },
      { status: 400 },
    );
  }

  try {
    const rates = await setRateFrom({
      crewMemberId: crewMemberId.trim(),
      rateCentsPerHour: rateCents,
      effectiveFrom,
      createdBy: gateActor(operator),
    });
    return NextResponse.json({ ok: true, rates });
  } catch (err) {
    const refusal = refusalResponse(err);
    if (refusal) return refusal;
    console.error('[api/admin/crew-rates] set failed:', err);
    return NextResponse.json({ error: 'Failed to save the rate' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { crewMemberId, rateId } = (body as {
    crewMemberId?: unknown;
    rateId?: unknown;
  } | null) ?? {};

  if (typeof crewMemberId !== 'string' || !crewMemberId.trim()) {
    return NextResponse.json(
      { error: 'crewMemberId is required', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (typeof rateId !== 'string' || !rateId.trim()) {
    return NextResponse.json({ error: 'rateId is required', code: 'invalid-body' }, { status: 400 });
  }

  try {
    const rates = await deleteRate({ crewMemberId: crewMemberId.trim(), rateId: rateId.trim() });
    return NextResponse.json({ ok: true, rates });
  } catch (err) {
    const refusal = refusalResponse(err);
    if (refusal) return refusal;
    console.error('[api/admin/crew-rates] delete failed:', err);
    return NextResponse.json({ error: 'Failed to remove the rate' }, { status: 500 });
  }
}
