import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listAllAccountsById, listNonCrewOperators } from '@/lib/auth/adminUsers';
import { dollarsToCents } from '@/lib/hourlyRate';
import { asJsonObject, parseTelegramUserId, TELEGRAM_USER_ID_ERROR } from '@/lib/telegramUserId';
import {
  clearStaffLogin,
  createFieldCrewMember,
  deleteStaffMember,
  getStaffMember,
  StaffHasRecordsError,
  linkOfficeStaff,
  linkStaffLogin,
  listAllStaff,
  listLinkedAuthUserIds,
  OfficeDisplayNameTakenError,
  OperatorAlreadyLinkedError,
  setStaffActive,
  setStaffRate,
  setStaffTelegram,
  setStaffType,
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
 *   PATCH /api/admin/staff → edit one thing: rate, Telegram, password, type,
 *                            a stale-login clear, or attaching an existing
 *                            operator login to an existing row (row 359)
 *                            or active
 *   DELETE /api/admin/staff → remove a staff row that has no work behind it
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
 *   - FIELD crew get NO login at all. Crew logins were retired (row 438); they
 *     work through the Telegram bot instead. A field person who needs the
 *     dashboard gets a normal operator account and is linked like office staff.
 * The type is stored as `is_office` and shown as a label. Everything downstream
 * of that — rate, Telegram, password, active — is identical for both.
 *
 * ADMIN ONLY, never dormancy-bypassed: `requireAdmin` fails closed. Not public,
 * so `operatorGate` treats it as operator-only by default and no allowlist
 * entry is needed.
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
          // Role is shown as a BADGE, not as a third group: role and
          // dispatchability are independent (Jason is an admin on a field row),
          // so grouping by role would pull people out of the group that says
          // who can be assigned to a job.
          role: account?.role ?? null,
          // Whether the LOGIN is a crew-role one. This decides two things the
          // office can see: a crew login cannot use the dashboard clock at all
          // (getOfficeClockCaller refuses it), and it is the only kind of login
          // that gets deleted alongside the staff row.
          isCrewLogin: account?.isCrew ?? false,
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

    // FIELD: a pay row only. Crew logins were RETIRED (row 438, Naldo 2026-08-28):
    // the `/api/ops/v1` surface they existed to reach was deleted with the
    // Operations Hub (row 433), so a minted crew login could reach nothing at all.
    // Field crew work through the Telegram bot, keyed on `telegram_user_id`, which
    // is a separate path and is unaffected. If a field person genuinely needs the
    // dashboard, an admin creates them a normal operator account under Staff
    // accounts and links it here — that is how Jason already works.
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) {
      return NextResponse.json({ error: 'Enter their name.' }, { status: 400 });
    }

    const member = await createFieldCrewMember({ displayName, baseRateCents });
    return NextResponse.json({ member }, { status: 201 });
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

/** Name plus email — the same stamp `shifts.manual_by`, `shift_settlements`
 * `paid_by` and the crew-rates route all use, so every identity on a payroll
 * screen reads alike and survives a rename. */
function rateActor(operator: { name: string | null; email: string | null }): string {
  const name = operator.name?.trim();
  const email = operator.email?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || 'admin';
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
  const hasType = typeof body?.isOffice === 'boolean';
  const hasClearLogin = body?.clearLogin === true;
  const linkAuthUserId = typeof body?.authUserId === 'string' ? body.authUserId.trim() : '';
  const hasLinkLogin = linkAuthUserId !== '';
  const hasActive = typeof body?.active === 'boolean';
  if (!hasRate && !hasTelegram && !hasPassword && !hasType && !hasClearLogin && !hasLinkLogin && !hasActive) {
    return NextResponse.json(
      { error: 'Nothing to update. Send active, isOffice, hourlyRate, telegramUserId, password, clearLogin or authUserId.' },
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
      // Stamp WHO changed it. This is the everyday raise path — far more
      // used than the Rate history panel — and without the actor most real
      // rate rows would carry no attribution at all, on the one table that
      // decides what everybody's hours are worth (admin lens on PR #1214).
      member = await setStaffRate(crewMemberId, baseRateCents, {
        createdBy: rateActor(auth.operator),
      });
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
    } else if (hasLinkLogin) {
      // ATTACH AN EXISTING OPERATOR TO AN EXISTING STAFF ROW.
      //
      // Without this the row-359 repair was only half a repair: clearing a dead
      // pointer left a row with no login and NO WAY to give it one, because the
      // only door that attaches a login is POST, and POST always INSERTS a new
      // row — so re-adding the same person collided with the table-wide unique
      // index on lower(trim(display_name)) and 409'd. The office was told to
      // "set them up with a new login now" and then could not. Caught by the
      // premerge staff lens.
      const target = await getStaffMember(crewMemberId);
      if (!target) {
        return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
      }
      if (target.authUserId) {
        return NextResponse.json(
          {
            error: `${target.displayName} already has a login linked. Clear it first if it no longer works.`,
          },
          { status: 409 },
        );
      }
      // Must be a real operator, and never a crew login: listNonCrewOperators
      // filters on the RAW app_metadata, before roleOf flattens crew to operator.
      const operators = await listNonCrewOperators(sb);
      if (!operators.some((o) => o.id === linkAuthUserId)) {
        return NextResponse.json(
          { error: 'That is not an operator account. Add them under Staff accounts first.' },
          { status: 400 },
        );
      }
      const alreadyLinked = await listLinkedAuthUserIds();
      if (alreadyLinked.has(linkAuthUserId)) {
        return NextResponse.json(
          { error: 'That operator is already linked to another staff member.' },
          { status: 409 },
        );
      }
      // linkStaffLogin is a compare-and-swap on auth_user_id IS NULL, so a
      // concurrent link loses rather than silently replacing the winner.
      member = await linkStaffLogin(crewMemberId, linkAuthUserId);
      if (!member) {
        return NextResponse.json(
          { error: `${target.displayName} was given a login by someone else just now. Reload and check.` },
          { status: 409 },
        );
      }
    } else if (hasClearLogin) {
      // ROW 359 REPAIR PATH, for an orphan created before the delete route
      // started clearing the pointer itself.
      //
      // ⚠️ THE GUARD IS THE WHOLE FEATURE. Clearing a LIVE login would lock a
      // working staff member out of the web clock, so this refuses unless the
      // linked id genuinely no longer resolves in the auth store. The office
      // cannot reach this from the UI for a healthy row either — the action only
      // renders when GET reported loginMissing — but the server decides, because
      // the UI's view can be stale by the time the click lands.
      const target = await getStaffMember(crewMemberId);
      if (!target) {
        return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
      }
      if (!target.authUserId) {
        return NextResponse.json(
          { error: `${target.displayName} has no login linked, so there is nothing to clear.` },
          { status: 409 },
        );
      }
      const accounts = await listAllAccountsById(sb);
      if (accounts.has(target.authUserId)) {
        return NextResponse.json(
          {
            error: `${target.displayName}'s login still exists, so it was not cleared. Use Reset password if they cannot get in, or remove the account under Staff accounts first.`,
          },
          { status: 409 },
        );
      }
      member = await clearStaffLogin(crewMemberId, target.authUserId);
      if (!member) {
        // Lost the compare-and-swap: the row's login changed between the
        // check above and this write, so the dead id we verified is no longer
        // what is there. Refuse rather than clear whatever replaced it.
        return NextResponse.json(
          { error: `${target.displayName}'s login changed while you were looking. Reload and check.` },
          { status: 409 },
        );
      }
    } else if (hasType) {
      const toOffice = body!.isOffice as boolean;
      if (toOffice) {
        // Moving to office is only meaningful for someone who can actually work
        // as office staff. A CREW-role login is refused by the dashboard clock
        // (getOfficeClockCaller returns is_crew), so flipping the flag alone
        // would drop them from the job-assignment roster while giving them
        // nothing back — a dead end reached through the UI's own repair action.
        const target = await getStaffMember(crewMemberId);
        if (!target) {
          return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
        }
        if (target.authUserId) {
          const accounts = await listAllAccountsById(sb);
          if (accounts.get(target.authUserId)?.isCrew) {
            return NextResponse.json(
              {
                error: `${target.displayName} signs in with a crew login, which cannot use the dashboard clock. Moving them to office would only take them off the job-assignment list. Give them an operator account under Staff accounts first, or remove this row and add them as office.`,
              },
              { status: 409 },
            );
          }
        }
      }
      member = await setStaffType(crewMemberId, toOffice);
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

/**
 * Remove a staff member.
 *
 * NOT the normal way to retire someone — deactivating keeps their pay records
 * and stops them clocking in. This is for a duplicate or mis-typed row, which
 * otherwise sits in the list forever holding a unique display name.
 *
 * Anyone with recorded time or job history is refused, and that refusal comes
 * from the database's own foreign keys rather than a check this route could
 * forget: `shifts`, `shift_breaks`, `job_segments` and `job_assignments` all
 * reference `crew_members` with NO ACTION.
 *
 * THE LOGIN IS ONLY DELETED WHEN IT IS A CREW LOGIN, because a crew-role login
 * exists solely to serve this staff row. An OPERATOR or ADMIN login is left
 * alone: it is a person's account in its own right, it may still be needed for
 * the dashboard, and removing accounts is the Staff accounts table's job.
 */
export async function DELETE(req: NextRequest) {
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

  try {
    const removed = await deleteStaffMember(crewMemberId);
    if (!removed) {
      return NextResponse.json({ error: 'That is not a staff member.' }, { status: 404 });
    }

    // The row is ALREADY GONE by this point and cannot be restored, so nothing
    // below may turn into a failure response: telling the admin the removal
    // failed when it succeeded is worse than telling them the login lingers.
    let loginDeleted = false;
    if (removed.authUserId) {
      try {
        const accounts = await listAllAccountsById(sb);
        const account = accounts.get(removed.authUserId);
        // Only a crew-role login is cleaned up here. Deleting an operator or
        // admin account as a side effect of removing a pay row would be a much
        // bigger action than the admin asked for.
        if (account?.isCrew) {
          const { error } = await sb.auth.admin.deleteUser(removed.authUserId);
          if (error) throw new Error(error.message);
          loginDeleted = true;
        }
      } catch (cleanupError) {
        console.error(
          'DELETE /api/admin/staff login cleanup:',
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
      }
    }

    return NextResponse.json({ removed, loginDeleted });
  } catch (e) {
    if (e instanceof StaffHasRecordsError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('DELETE /api/admin/staff:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to remove the staff member' }, { status: 500 });
  }
}
