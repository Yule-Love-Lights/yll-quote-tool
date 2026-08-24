import { NextRequest, NextResponse } from 'next/server';

import { getOfficeClockCaller, officeDenialResponse } from '@/lib/auth/officeClock';
import { clockIn, clockOut, getOpenShift } from '@/lib/shifts';
import { endBreak, getOpenBreak, startBreak } from '@/lib/shiftBreaks';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * The office web clock (row 337 — office/web clock-in).
 *
 *   GET  /api/office/clock — the caller's current state: clocked in? on break?
 *   POST /api/office/clock — { action: 'in' | 'out' | 'break-start' | 'break-end' }
 *
 * OFFICE LANE, `source: 'office'`. The caller is resolved from the session
 * (`getOfficeClockCaller`), never from the body, so this only ever clocks the
 * signed-in person in or out. It writes payroll, so it fails closed (see the
 * resolver's doc block) rather than leaning on the perimeter, which is dormant
 * while `AUTH_GATE_ENABLED` is off.
 *
 * Not public and not under `/api/ops/v1` (the crew surface), so `operatorGate`
 * treats it as operator-only by default — no allowlist entry needed, and a
 * signed-out request 401s here AND at the perimeter.
 *
 * The actions tolerate a double-tap AND a genuine multi-tab / multi-device race,
 * because the person on the clock cannot see our database and WILL tap twice:
 * clocking in when already in returns the open shift; starting a break when one
 * is open is a no-op; and clocking out / ending a break swallow a lost CAS race
 * when the shift or break is already closed, since the desired end state is
 * already reached. A clock-out or break-end with NOTHING open at all is a 409,
 * not a silent success — the person genuinely was not on the clock / on a break.
 */

const SOURCE = 'office' as const;

const ACTIONS = ['in', 'out', 'break-start', 'break-end'] as const;
type Action = (typeof ACTIONS)[number];

function isAction(v: unknown): v is Action {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

/** The whole clock state the UI renders from — one round-trip, no guessing. */
async function currentState(crewMemberId: string) {
  const shift = await getOpenShift(crewMemberId);
  const openBreak = shift ? await getOpenBreak(shift.id) : null;
  return {
    clockedIn: shift !== null,
    onBreak: openBreak !== null,
    shift,
    break: openBreak,
  };
}

export async function GET() {
  const auth = await getOfficeClockCaller();
  if (!auth.ok) return officeDenialResponse(auth.reason);
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const state = await currentState(auth.caller.crewMemberId);
  return NextResponse.json({ staff: { name: auth.caller.displayName }, ...state });
}

export async function POST(req: NextRequest) {
  const auth = await getOfficeClockCaller();
  if (!auth.ok) return officeDenialResponse(auth.reason);
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (!isAction(body?.action)) {
    return NextResponse.json(
      { error: `action must be one of ${ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }
  const action: Action = body.action;
  const { crewMemberId } = auth.caller;

  try {
    switch (action) {
      case 'in': {
        // clockIn returns the already-open shift if there is one, so a second
        // tap is a no-op, not a duplicate.
        await clockIn(crewMemberId, SOURCE);
        break;
      }
      case 'out': {
        const shift = await getOpenShift(crewMemberId);
        if (!shift) {
          return NextResponse.json({ error: 'You are not clocked in.' }, { status: 409 });
        }
        try {
          await clockOut(shift.id, crewMemberId, SOURCE);
        } catch (raceError) {
          // Lost a race to a concurrent clock-out (multi-tab / multi-device): the
          // CAS matched no still-open row and clockOut threw. If we are now
          // clocked out, the desired end state is already reached — that is an
          // idempotent success, not a false 500. Only re-throw a genuine failure.
          if (await getOpenShift(crewMemberId)) throw raceError;
        }
        break;
      }
      case 'break-start': {
        const shift = await getOpenShift(crewMemberId);
        if (!shift) {
          return NextResponse.json(
            { error: 'Clock in before starting a break.' },
            { status: 409 },
          );
        }
        const open = await getOpenBreak(shift.id);
        if (open) break; // already on break — idempotent
        await startBreak(shift.id, crewMemberId, SOURCE);
        break;
      }
      case 'break-end': {
        const shift = await getOpenShift(crewMemberId);
        if (!shift) {
          return NextResponse.json({ error: 'You are not clocked in.' }, { status: 409 });
        }
        const open = await getOpenBreak(shift.id);
        if (!open) {
          return NextResponse.json({ error: 'You are not on a break.' }, { status: 409 });
        }
        try {
          await endBreak(open.id, crewMemberId, SOURCE);
        } catch (raceError) {
          // Same idempotency as clock-out: if the break is already ended (a lost
          // race, or a concurrent clock-out auto-closed it), that is the desired
          // end state, not a failure. Only re-throw if a break is still open.
          if (await getOpenBreak(shift.id)) throw raceError;
        }
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Clock action failed';
    console.error(`POST /api/office/clock (${action}):`, message);
    return NextResponse.json({ error: 'Clock action failed' }, { status: 500 });
  }

  // Always answer with the fresh state so the UI reflects reality, never its own
  // optimistic guess about what the tap did.
  const state = await currentState(crewMemberId);
  return NextResponse.json({ staff: { name: auth.caller.displayName }, ...state });
}
