import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listNonCrewOperators } from '@/lib/auth/adminUsers';
import { dollarsToCents } from '@/lib/hourlyRate';
import { asJsonObject, parseTelegramUserId, TELEGRAM_USER_ID_ERROR } from '@/lib/telegramUserId';
import {
  linkOfficeStaff,
  listLinkedAuthUserIds,
  listOfficeStaff,
  OfficeDisplayNameTakenError,
  OperatorAlreadyLinkedError,
  setOfficeStaffActive,
  setOfficeStaffRate,
  setOfficeStaffTelegram,
  TelegramUserIdTakenError,
} from '@/lib/crewMembers';

export const runtime = 'nodejs';

/**
 * Office-staff onboarding (ledger #354).
 *
 *   GET   /api/admin/office-staff → current office staff + operators eligible to
 *                                   become office staff
 *   POST  /api/admin/office-staff → link an existing operator as office staff
 *                                   (creates their crew_members pay row)
 *   PATCH /api/admin/office-staff → activate / deactivate an office staffer
 *
 * This replaces the hand-written SQL that used to be the only way to give an
 * office person (Naldo, Kelly, ...) a time-clock identity. Office staff sign in
 * with an OPERATOR login and clock in on the office web clock; their pay identity
 * is a crew_members row with is_office=true whose auth_user_id points at that
 * operator login, which is exactly what getOfficeClockCaller resolves a punch
 * through.
 *
 * NO CREDENTIALS ARE HANDLED HERE. The operator already has a login (created on
 * the Staff accounts panel); this only writes the pay row that ties their
 * existing session to the clock. That is why the picker offers EXISTING operators
 * rather than creating new auth users — and why crew logins are excluded from it
 * (a crew login is a different population and would be rejected by the clock
 * anyway).
 *
 * ADMIN ONLY, never dormancy-bypassed: requireAdmin fails closed. Not public and
 * not under /api/ops/v1, so operatorGate treats it as operator-only by default —
 * no allowlist entry needed, same as the sibling /api/admin/crew-accounts route.
 */

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  try {
    const [officeStaff, linked, operators] = await Promise.all([
      listOfficeStaff(),
      listLinkedAuthUserIds(),
      listNonCrewOperators(sb),
    ]);

    const opById = new Map(operators.map((o) => [o.id, o]));

    return NextResponse.json({
      officeStaff: officeStaff.map((s) => {
        const op = s.authUserId ? opById.get(s.authUserId) : undefined;
        return {
          id: s.id,
          displayName: s.displayName,
          active: s.active,
          authUserId: s.authUserId,
          baseRateCents: s.baseRateCents,
          telegramUserId: s.telegramUserId,
          operatorEmail: op?.email ?? null,
          operatorName: op?.name ?? null,
          // The linked operator login no longer exists (deleted from the accounts
          // store). Surfaced so an orphaned pay row is visible in the panel, not
          // silently left showing as a normal active staffer.
          operatorMissing: s.authUserId !== null && !opById.has(s.authUserId),
        };
      }),
      // An operator is eligible only if they are NOT already linked to any
      // crew_members row (field crew or office). Crew logins are already excluded
      // by listNonCrewOperators.
      eligibleOperators: operators
        .filter((o) => !linked.has(o.id))
        .map((o) => ({ id: o.id, name: o.name, email: o.email })),
    });
  } catch (err) {
    console.error('GET /api/admin/office-staff:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to load office staff' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  // Narrowed to a plain object (or null): a JSON primitive body like `42` would
  // otherwise reach the `in` operator below and throw a TypeError instead of
  // returning this route's own 400.
  const body = asJsonObject(await req.json().catch(() => null));
  const authUserId = String(body?.authUserId ?? '').trim();
  if (!authUserId) {
    return NextResponse.json({ error: 'Choose an operator to set up.' }, { status: 400 });
  }

  const baseRateCents = dollarsToCents(body?.hourlyRate);
  if (baseRateCents === null) {
    return NextResponse.json(
      { error: 'Enter a valid hourly rate, for example 22.50.' },
      { status: 400 },
    );
  }

  try {
    // The operator must be a real, non-crew operator account and must not already
    // be linked. Both are re-checked server-side; the picker only hides them.
    const operators = await listNonCrewOperators(sb);
    const operator = operators.find((o) => o.id === authUserId);
    if (!operator) {
      return NextResponse.json(
        { error: 'That is not an operator account. Add them under Staff accounts first.' },
        { status: 400 },
      );
    }

    const linked = await listLinkedAuthUserIds();
    if (linked.has(authUserId)) {
      return NextResponse.json(
        { error: `${operator.name ?? operator.email ?? 'That operator'} is already set up as staff.` },
        { status: 409 },
      );
    }

    // The display name defaults to the operator's name (email local part as a
    // last resort), and can be overridden to resolve a name collision without SQL.
    const override = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    const displayName = override || operator.name || operator.email?.split('@')[0] || '';
    if (!displayName) {
      return NextResponse.json({ error: 'A display name is required.' }, { status: 400 });
    }

    const member = await linkOfficeStaff({ authUserId, displayName, baseRateCents });
    return NextResponse.json({ member }, { status: 201 });
  } catch (e) {
    if (e instanceof OperatorAlreadyLinkedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof OfficeDisplayNameTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('POST /api/admin/office-staff:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to set up office staff' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  // Narrowed to a plain object (or null): a JSON primitive body like `42` would
  // otherwise reach the `in` operator below and throw a TypeError instead of
  // returning this route's own 400.
  const body = asJsonObject(await req.json().catch(() => null));
  const crewMemberId = String(body?.crewMemberId ?? '').trim();
  if (!crewMemberId) {
    return NextResponse.json({ error: 'Choose an office staff member.' }, { status: 400 });
  }

  // Three independent edits share PATCH: an active toggle, a rate correction,
  // and a Telegram link. The office sends exactly one at a time; the order below
  // is the precedence if more than one somehow arrives.
  const hasRate = body?.hourlyRate !== undefined;
  const hasTelegram = body !== null && 'telegramUserId' in body;
  const hasActive = typeof body?.active === 'boolean';
  if (!hasRate && !hasTelegram && !hasActive) {
    return NextResponse.json(
      { error: 'Nothing to update. Send active, hourlyRate or telegramUserId.' },
      { status: 400 },
    );
  }

  try {
    let member;
    if (hasRate) {
      const baseRateCents = dollarsToCents(body?.hourlyRate);
      if (baseRateCents === null) {
        return NextResponse.json(
          { error: 'Enter a valid hourly rate, for example 22.50.' },
          { status: 400 },
        );
      }
      member = await setOfficeStaffRate(crewMemberId, baseRateCents);
    } else if (hasTelegram) {
      // Office staff text the bot too (Naldo, 2026-08-24). null unlinks; a
      // missing key is a caller bug, never a silent unlink.
      const parsed = parseTelegramUserId(body?.telegramUserId);
      if (!parsed.ok) {
        return NextResponse.json(
          {
            error:
              parsed.reason === 'missing'
                ? 'telegramUserId is required (send null to unlink).'
                : TELEGRAM_USER_ID_ERROR,
          },
          { status: 400 },
        );
      }
      member = await setOfficeStaffTelegram(crewMemberId, parsed.telegramUserId);
    } else {
      member = await setOfficeStaffActive(crewMemberId, body!.active as boolean);
    }
    // null means no is_office row matched — either an unknown id or a FIELD-crew
    // row (which the by-construction filter refuses to touch here).
    if (!member) {
      return NextResponse.json({ error: 'That is not an office staff member.' }, { status: 404 });
    }
    return NextResponse.json({ member });
  } catch (e) {
    // A partial unique index guards telegram_user_id, so this is a real "that
    // account already belongs to someone else" the office can fix, not a 500.
    if (e instanceof TelegramUserIdTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('PATCH /api/admin/office-staff:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to update office staff' }, { status: 500 });
  }
}
