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
 * Every action is idempotent against a double-tap: clocking in when already in
 * returns the open shift, and starting a break when one is open returns it,
 * because the person on the clock cannot see our database and WILL tap twice.
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
        await clockOut(shift.id, crewMemberId, SOURCE);
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
        await endBreak(open.id, crewMemberId, SOURCE);
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
