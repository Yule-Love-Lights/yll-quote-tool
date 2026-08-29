// Manual shift entry and correction (2026-08-29, Naldo's ruling): admins
// reconstruct a forgotten clock-in by reading the GPS timeline and TYPING the
// times. ADMIN ONLY — this writes the payroll record. GPS never writes
// payroll: the body carries only human-typed times, and the row is stamped
// with who typed them (manual_by), which the two-clocks page renders.
//
// POST /api/admin/shifts/manual
// Body: { crewMemberId, clockInAt, clockOutAt }            → create
//       { shiftId, clockInAt, clockOutAt }                 → edit times
// DELETE /api/admin/shifts/manual
// Body: { shiftId }                                        → void the entry
// Times are ISO timestamps. Response: { ok: true, shift } | { error, code }.
//
// Refusals map straight from the lib's typed error: invalid-times 400,
// not-found 404, overlap and edit-race 409. Nothing here retries — an
// edit-race means the row moved (a crew clock-out, another admin) and the
// human should look again before writing payroll times.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  adminCreateShift,
  adminUpdateShiftTimes,
  adminVoidShift,
  ManualShiftRefusedError,
} from '@/lib/shifts';

export const runtime = 'nodejs';

const REFUSAL_STATUS: Record<ManualShiftRefusedError['code'], number> = {
  'invalid-times': 400,
  'not-found': 404,
  overlap: 409,
  'edit-race': 409,
  'not-field-crew': 409,
  // Both mean "this row is not yours to delete", which is a conflict with the
  // state of the record rather than a bad request.
  'not-manual': 409,
  'has-children': 409,
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

  const isEdit = shiftId !== undefined;
  // clockOutAt may be null ONLY on an edit (it means "leave the shift open",
  // valid only while the shift IS open — the lib enforces that half).
  const outOk = typeof clockOutAt === 'string' || (isEdit && clockOutAt === null);
  if (typeof clockInAt !== 'string' || !outOk) {
    return NextResponse.json(
      { error: 'clockInAt and clockOutAt are required timestamps', code: 'invalid-body' },
      { status: 400 },
    );
  }
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
      : await adminCreateShift({
          crewMemberId: crewMemberId as string,
          clockInAt,
          clockOutAt: clockOutAt as string,
          actor,
        });
    return NextResponse.json({ ok: true, shift });
  } catch (err) {
    if (err instanceof ManualShiftRefusedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSAL_STATUS[err.code] });
    }
    console.error('[api/admin/shifts/manual] write failed:', err);
    return NextResponse.json({ error: 'Failed to save the shift' }, { status: 500 });
  }
}

// Name plus email: two admins could share a display name, and a renamed
// account would orphan a name-only trail (PR #1062 admin lens). The email is
// the auth identity, so the stamp stays resolvable.
function gateActor(operator: { name: string | null; email: string | null }): string {
  const name = operator.name?.trim();
  const email = operator.email?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || 'admin';
}

/**
 * Void a manual entry. A shift typed by mistake cannot be corrected by
 * shrinking it, because a one-minute shift is still payroll, so the row goes
 * (row 458). The lib refuses anything that is not an office-typed entry, and
 * anything carrying a break or job time; this handler only maps those typed
 * refusals to statuses so the admin reads a real reason rather than
 * "something went wrong".
 */
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

  const { shiftId } = (body as { shiftId?: unknown } | null) ?? {};
  if (typeof shiftId !== 'string' || !shiftId.trim()) {
    return NextResponse.json(
      { error: 'shiftId is required', code: 'invalid-body' },
      { status: 400 },
    );
  }

  try {
    await adminVoidShift({ shiftId, actor: gateActor(operator) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ManualShiftRefusedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSAL_STATUS[err.code] });
    }
    console.error('[api/admin/shifts/manual] void failed:', err);
    return NextResponse.json({ error: 'Failed to remove the shift' }, { status: 500 });
  }
}
