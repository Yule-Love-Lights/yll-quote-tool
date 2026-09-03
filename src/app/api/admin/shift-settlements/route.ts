// Recording and undoing a payment for someone's shifts — time-tracking plan
// phase 3, ledger row 459. ADMIN ONLY: this writes the payroll payment record.
//
// POST   { crewMemberId, shiftIds[], amount, method, note? }  → record
// DELETE { settlementId, reason }                             → undo
//
// `amount` is what an admin TYPED. The tool never computes a payment (see
// shiftSettlements.ts): overtime has no ruling here, so a figure this code
// produced would be wrong for a real week that already exists in the data.
// The string is parsed server-side rather than trusting a number from the
// client, so "1,350.00" and "1350" mean the same thing and "1350.005" is
// refused rather than silently rounded into somebody's pay.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  isSettlementMethod,
  parseAmountCents,
  recordShiftSettlement,
  voidShiftSettlement,
  SettlementRefusedError,
} from '@/lib/shiftSettlements';

export const runtime = 'nodejs';

const REFUSAL_STATUS: Record<SettlementRefusedError['code'], number> = {
  'no-shifts': 400,
  'invalid-amount': 400,
  'invalid-method': 400,
  'not-found': 404,
  // All conflicts with the state of the record: the request was well formed,
  // the world moved or disagrees.
  'not-theirs': 409,
  'still-open': 409,
  'already-settled': 409,
  'lost-race': 409,
};

/** Name plus email, the same stamp `shifts.manual_by` carries, so the two
 * identities on a payroll screen read alike and survive a rename. */
function gateActor(operator: { name: string | null; email: string | null }): string {
  const name = operator.name?.trim();
  const email = operator.email?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || 'admin';
}

function refusalResponse(err: unknown): NextResponse | null {
  if (err instanceof SettlementRefusedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSAL_STATUS[err.code] });
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

  const { crewMemberId, shiftIds, amount, method, note } = (body as {
    crewMemberId?: unknown;
    shiftIds?: unknown;
    amount?: unknown;
    method?: unknown;
    note?: unknown;
  } | null) ?? {};

  if (typeof crewMemberId !== 'string' || !crewMemberId.trim()) {
    return NextResponse.json({ error: 'crewMemberId is required', code: 'invalid-body' }, { status: 400 });
  }
  if (!Array.isArray(shiftIds) || shiftIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'shiftIds must be a list of ids', code: 'invalid-body' }, { status: 400 });
  }
  if (!isSettlementMethod(method)) {
    return NextResponse.json({ error: 'Pick how it was paid.', code: 'invalid-method' }, { status: 400 });
  }
  if (typeof amount !== 'string') {
    return NextResponse.json(
      { error: 'Enter the amount actually paid.', code: 'invalid-amount' },
      { status: 400 },
    );
  }
  const totalCents = parseAmountCents(amount);
  if (totalCents === null) {
    return NextResponse.json(
      { error: 'That is not an amount. Enter dollars and cents, like 1350.00.', code: 'invalid-amount' },
      { status: 400 },
    );
  }

  try {
    const settlement = await recordShiftSettlement({
      crewMemberId,
      shiftIds: shiftIds as string[],
      totalCents,
      paidBy: gateActor(operator),
      method,
      note: typeof note === 'string' ? note : null,
    });
    return NextResponse.json({ ok: true, settlement });
  } catch (err) {
    const refusal = refusalResponse(err);
    if (refusal) return refusal;
    console.error('[api/admin/shift-settlements] record failed:', err);
    return NextResponse.json({ error: 'Failed to record the payment' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
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

  const { settlementId, reason } = (body as { settlementId?: unknown; reason?: unknown } | null) ?? {};
  if (typeof settlementId !== 'string' || !settlementId.trim()) {
    return NextResponse.json({ error: 'settlementId is required', code: 'invalid-body' }, { status: 400 });
  }
  // A reason is required by the lib too; refusing here gives a plain sentence
  // rather than a typed error the client has to translate.
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json(
      { error: 'Say why this payment is being undone.', code: 'invalid-body' },
      { status: 400 },
    );
  }

  try {
    const settlement = await voidShiftSettlement({
      settlementId,
      voidedBy: gateActor(operator),
      reason,
    });
    return NextResponse.json({ ok: true, settlement });
  } catch (err) {
    const refusal = refusalResponse(err);
    if (refusal) return refusal;
    console.error('[api/admin/shift-settlements] void failed:', err);
    return NextResponse.json({ error: 'Failed to undo the payment' }, { status: 500 });
  }
}
