// Manual shift entry and correction (2026-08-29, Naldo's ruling): admins
// reconstruct a forgotten clock-in by reading the GPS timeline and TYPING the
// times. ADMIN ONLY — this writes the payroll record. GPS never writes
// payroll: the body carries only human-typed times, and the row is stamped
// with who typed them (manual_by), which the two-clocks page renders.
//
// POST /api/admin/shifts/manual
// Body: { crewMemberId, clockInAt, clockOutAt }            → create
//       { shiftId, clockInAt, clockOutAt }                 → edit times
// Times are ISO timestamps. Response: { ok: true, shift } | { error, code }.
//
// Refusals map straight from the lib's typed error: invalid-times 400,
// not-found 404, overlap and edit-race 409. Nothing here retries — an
// edit-race means the row moved (a crew clock-out, another admin) and the
// human should look again before writing payroll times.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { adminCreateShift, adminUpdateShiftTimes, ManualShiftRefusedError } from '@/lib/shifts';

export const runtime = 'nodejs';

const REFUSAL_STATUS: Record<ManualShiftRefusedError['code'], number> = {
  'invalid-times': 400,
  'not-found': 404,
  overlap: 409,
  'edit-race': 409,
};

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

  const { shiftId, crewMemberId, clockInAt, clockOutAt } = (body as {
    shiftId?: unknown;
    crewMemberId?: unknown;
    clockInAt?: unknown;
    clockOutAt?: unknown;
  } | null) ?? {};

  if (typeof clockInAt !== 'string' || typeof clockOutAt !== 'string') {
    return NextResponse.json(
      { error: 'clockInAt and clockOutAt are required timestamps', code: 'invalid-body' },
      { status: 400 },
    );
  }
  const isEdit = shiftId !== undefined;
  if (isEdit && typeof shiftId !== 'string') {
    return NextResponse.json({ error: 'shiftId must be a string', code: 'invalid-body' }, { status: 400 });
  }
  if (!isEdit && typeof crewMemberId !== 'string') {
    return NextResponse.json(
      { error: 'crewMemberId is required to create a shift', code: 'invalid-body' },
      { status: 400 },
    );
  }

  // The audit identity: the admin's display name, falling back to their email.
  // Never blank — requireAdmin guarantees a real operator.
  const actor = gateActor(operator);

  try {
    const shift = isEdit
      ? await adminUpdateShiftTimes({ shiftId: shiftId as string, clockInAt, clockOutAt, actor })
      : await adminCreateShift({ crewMemberId: crewMemberId as string, clockInAt, clockOutAt, actor });
    return NextResponse.json({ ok: true, shift });
  } catch (err) {
    if (err instanceof ManualShiftRefusedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSAL_STATUS[err.code] });
    }
    console.error('[api/admin/shifts/manual] write failed:', err);
    return NextResponse.json({ error: 'Failed to save the shift' }, { status: 500 });
  }
}

function gateActor(operator: { name: string | null; email: string | null }): string {
  return operator.name?.trim() || operator.email?.trim() || 'admin';
}
