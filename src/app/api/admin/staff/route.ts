import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listAllAccountsById, listNonCrewOperators } from '@/lib/auth/adminUsers';
import { crewAppMetadata, crewMetadataIsSafe, validateCrewCredentials } from '@/lib/auth/crewAccounts';
import { dollarsToCents } from '@/lib/hourlyRate';
import { asJsonObject, parseTelegramUserId, TELEGRAM_USER_ID_ERROR } from '@/lib/telegramUserId';
import {
  createFieldCrewMember,
  linkOfficeStaff,
  linkStaffLogin,
  listAllStaff,
  listLinkedAuthUserIds,
  OfficeDisplayNameTakenError,
  OperatorAlreadyLinkedError,
  setStaffActive,
  setStaffRate,
  setStaffTelegram,
  TelegramUserIdTakenError,
} from '@/lib/crewMembers';

export const runtime = 'nodejs';

/**
 * Staff management — ONE door for every staff member (ledger #354, unified
 * 2026-08-24 on Naldo's ruling: "everything needs to be exactly the same").
 *
 *   GET   /api/admin/staff → every staff member, office and field, with their
 *                            login, rate, Telegram link and active state
 *   POST  /api/admin/staff → add a person, either type
 *   PATCH /api/admin/staff → edit one thing: rate, Telegram, password or active
 *
 * WHY ONE ROUTE. This replaces `/api/admin/crew-accounts` (field) and
 * `/api/admin/office-staff` (office), which did the same job in two different
 * shapes: one linked Telegram through a separate form, the other inline; one
 * showed rates, the other did not; neither could reset a crew password. Two
 * doors writing one table also had to be kept byte-identical by hand, which is
 * exactly how they drifted. One door, one shape, four identical actions.
 *
 * THE TWO POPULATIONS STILL DIFFER IN ONE WAY, and it is a permission boundary,
 * not a presentation one:
 *   - OFFICE staff sign in with an EXISTING OPERATOR login. This route never
 *     mints one; it links the operator the admin picked. That is what keeps a
 *     crew-role login from ever being created for someone who already holds an
 *     operator account.
 *   - FIELD crew get a CREW-role login minted here (app_metadata.role='crew'),
 *     which `getOperator` rejects, confining it to the crew API.
 * The type is stored as `is_office` and shown as a label. Everything downstream
 * of that — rate, Telegram, password, active — is identical for both.
 *
 * ADMIN ONLY, never dormancy-bypassed: `requireAdmin` fails closed. Not public
 * and not under `/api/ops/v1`, so `operatorGate` treats it as operator-only by
 * default and no allowlist entry is needed.
 *
 * A PASSWORD IS NEVER RESET BY RAW auth id. The target is resolved from the
 * staff row's own `auth_user_id`, so an admin can only reset the password of a
 * login that is actually attached to a staff member they can see.
 */

const MIN_PASSWORD = 8;

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  try {
    const [staff, linked, operators, accountsById] = await Promise.all([
      listAllStaff(),
      listLinkedAuthUserIds(),
      listNonCrewOperators(sb),
      listAllAccountsById(sb),
    ]);

    return NextResponse.json({
      staff: staff.map((s) => {
        const account = s.authUserId ? accountsById.get(s.authUserId) : undefined;
        return {
          id: s.id,
          displayName: s.displayName,
          active: s.active,
          isOffice: s.isOffice,
          baseRateCents: s.baseRateCents,
          telegramUserId: s.telegramUserId,
          hasLogin: s.authUserId !== null,
          email: account?.email ?? null,
          // The linked login no longer exists (deleted from the accounts store).
          // Surfaced so an orphaned pay row is visible rather than silently
          // showing as a normal active staffer.
          loginMissing: s.authUserId !== null && !accountsById.has(s.authUserId),
        };
      }),
      // Operators eligible to become OFFICE staff: not already linked to any
      // staff row. Crew logins are excluded by listNonCrewOperators, so a crew
      // login can never be offered as an office staffer.
      eligibleOperators: operators
        .filter((o) => !linked.has(o.id))
        .map((o) => ({ id: o.id, name: o.name, email: o.email })),
    });
  } catch (err) {
    console.error('GET /api/admin/staff:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to load staff' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = asJsonObject(await req.json().catch(() => null));
  const type = String(body?.type ?? '').trim();
  if (type !== 'office' && type !== 'field') {
    return NextResponse.json({ error: 'Choose whether this person is office or field.' }, { status: 400 });
  }

  const baseRateCents = dollarsToCents(body?.hourlyRate);
  if (baseRateCents === null) {
    return NextResponse.json({ error: 'Enter a valid hourly rate, for example 22.50.' }, { status: 400 });
  }

  try {
    if (type === 'office') {
      const authUserId = String(body?.authUserId ?? '').trim();
      if (!authUserId) {
        return NextResponse.json({ error: 'Choose an operator to set up.' }, { status: 400 });
      }
      // Re-checked server-side; the picker only hides the ineligible ones.
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

      const override = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
      const displayName = override || operator.name || operator.email?.split('@')[0] || '';
      if (!displayName) {
        return NextResponse.json({ error: 'A display name is required.' }, { status: 400 });
      }

      const member = await linkOfficeStaff({ authUserId, displayName, baseRateCents });
      return NextResponse.json({ member }, { status: 201 });
    }

    // FIELD: create the pay row, then mint and attach a crew-role login.
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) {
      return NextResponse.json({ error: 'Enter their name.' }, { status: 400 });
    }
    const email = String(body?.email ?? '').trim();
    const password = String(body?.password ?? '');
    const guard = validateCrewCredentials({ email, password });
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });

    const member = await createFieldCrewMember({ displayName, baseRateCents });

    const meta = crewAppMetadata(displayName);
    // Belt and braces: refuse to create anything that would not read as crew.
    if (!crewMetadataIsSafe(meta)) {
      console.error('POST /api/admin/staff: refusing unsafe crew metadata');
      return NextResponse.json({ error: 'Internal role configuration error' }, { status: 500 });
    }

    const { data: created, error: createError } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: meta,
    });
    if (createError || !created?.user) {
      const message = createError?.message ?? 'Failed to create the login';
      console.error('POST /api/admin/staff create:', message);
      // The pay row stands with no login — a legitimate state the panel shows as
      // "No login yet", with a Create login action to finish the job.
      const conflict = /already|exists|registered/i.test(message);
      return NextResponse.json(
        { error: `${displayName} was added, but the login was not created: ${message}` },
        { status: conflict ? 409 : 500 },
      );
    }

    const linkedMember = await linkStaffLogin(member.id, created.user.id);
    if (!linkedMember) {
      // Lost the compare-and-swap, so this auth user is an orphan. Delete it
      // rather than leave a login nobody can reach.
      await sb.auth.admin.deleteUser(created.user.id).catch(() => {});
      return NextResponse.json(
        { error: `${displayName} was added, but the login could not be attached and was rolled back.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ member: linkedMember }, { status: 201 });
  } catch (e) {
    if (e instanceof OperatorAlreadyLinkedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof OfficeDisplayNameTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('POST /api/admin/staff:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to add the staff member' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = asJsonObject(await req.json().catch(() => null));
  const crewMemberId = String(body?.crewMemberId ?? '').trim();
  if (!crewMemberId) {
    return NextResponse.json({ error: 'Choose a staff member.' }, { status: 400 });
  }

  // Four independent edits share PATCH; the UI sends exactly one at a time and
  // this is the precedence if more than one arrives.
  const hasRate = body?.hourlyRate !== undefined;
  const hasTelegram = body !== null && 'telegramUserId' in body;
  const hasPassword = body?.password !== undefined;
  const hasActive = typeof body?.active === 'boolean';
  if (!hasRate && !hasTelegram && !hasPassword && !hasActive) {
    return NextResponse.json(
      { error: 'Nothing to update. Send active, hourlyRate, telegramUserId or password.' },
      { status: 400 },
    );
  }

  try {
    if (hasPassword) {
      const password = String(body?.password ?? '');
      if (password.length < MIN_PASSWORD) {
        return NextResponse.json(
          { error: `Password must be at least ${MIN_PASSWORD} characters.` },
          { status: 400 },
        );
      }
      // The auth id comes from the STAFF ROW, never from the body: an admin can
      // only reset a login that is actually attached to a staff member.
      const staff = await listAllStaff();
      const member = staff.find((s) => s.id === crewMemberId);
      if (!member) {
        return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
      }
      if (!member.authUserId) {
        return NextResponse.json(
          { error: `${member.displayName} has no login yet, so there is no password to reset.` },
          { status: 409 },
        );
      }
      const { error } = await sb.auth.admin.updateUserById(member.authUserId, { password });
      if (error) {
        console.error('PATCH /api/admin/staff password:', error.message);
        return NextResponse.json({ error: 'Failed to reset the password' }, { status: 500 });
      }
      return NextResponse.json({ member });
    }

    let member;
    if (hasRate) {
      const baseRateCents = dollarsToCents(body?.hourlyRate);
      if (baseRateCents === null) {
        return NextResponse.json(
          { error: 'Enter a valid hourly rate, for example 22.50.' },
          { status: 400 },
        );
      }
      member = await setStaffRate(crewMemberId, baseRateCents);
    } else if (hasTelegram) {
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
      member = await setStaffTelegram(crewMemberId, parsed.telegramUserId);
    } else {
      member = await setStaffActive(crewMemberId, body!.active as boolean);
    }

    if (!member) {
      return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
    }
    return NextResponse.json({ member });
  } catch (e) {
    if (e instanceof TelegramUserIdTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('PATCH /api/admin/staff:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to update the staff member' }, { status: 500 });
  }
}
