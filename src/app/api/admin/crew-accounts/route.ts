import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  crewAppMetadata,
  crewMetadataIsSafe,
  validateCrewAccount,
} from '@/lib/auth/crewAccounts';
import { TelegramUserIdTakenError, updateCrewMember } from '@/lib/crewMembers';

export const runtime = 'nodejs';

/**
 * Crew login management (row 279).
 *
 *   GET   /api/admin/crew-accounts → every crew member, their login state and
 *                                    their Telegram link
 *   POST  /api/admin/crew-accounts → create a login and link it to a crew member
 *   PATCH /api/admin/crew-accounts → link or unlink a crew member's Telegram
 *
 * WHY PATCH EXISTS (row 313). A crew LOGIN and a crew member's TELEGRAM are two
 * independent identities, and only the second one reaches the time clock:
 * `handleCrewTimeMessage` resolves the sender through
 * `getCrewMemberByTelegramUserId`, never through the auth session. Before this,
 * NOTHING in the app could write `crew_members.telegram_user_id` —
 * `updateCrewMember` existed with zero callers — so the entire Telegram time
 * clock was unreachable by every crew member, and creating a login did not
 * change that. Linking is an office task, so it lives on the office's screen
 * instead of in a hand-written SQL UPDATE.
 *
 * ⚠️ LINKING IS NECESSARY BUT NOT SUFFICIENT. The Telegram webhook drops any
 * message whose CHAT is not in `TELEGRAM_ALLOWED_CHATS` (`isAllowedChat`, in
 * src/app/api/integrations/telegram/webhook/route.ts) BEFORE the dispatcher —
 * and so before any of this — ever runs. A linked crew member texting in an
 * already-allowlisted crew group therefore works with no further setup, but a
 * 1:1 DM does NOT until their own id is added to that env var, because in a
 * private chat `chat.id` equals `from.id`. What they get is silence, not an
 * error. The Settings copy says so; do not soften it without changing the gate.
 *
 * ADMIN ONLY, and never dormancy-bypassed: `requireAdmin` fails closed. Creating
 * a login is exactly the kind of thing that must not be reachable anonymously.
 *
 * WHY THIS ROUTE EXISTS SEPARATELY from POST /api/admin/users: that route's
 * guard hard-rejects any role outside admin/operator, which is correct and stays
 * that way. A crew login is a different population with different privileges, so
 * it gets its own door and its own guard.
 */

type CrewRow = {
  id: string;
  display_name: string;
  active: boolean;
  auth_user_id: string | null;
  telegram_user_id: string | null;
};

/**
 * Telegram user ids are positive integers. Digits-only keeps a pasted @handle
 * ("@sonson") from being stored as a link that can never match, because the
 * webhook resolves the sender from `String(msg.from.id)`.
 *
 * A LEADING ZERO is rejected for the same reason: `String(Number)` never
 * produces one, so "0123456789" is a typo that would store cleanly and then
 * silently never match a single inbound message.
 */
const TELEGRAM_USER_ID_RE = /^[1-9]\d{0,19}$/;

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { data, error } = await sb
    .from('crew_members')
    .select('id, display_name, active, auth_user_id, telegram_user_id')
    .order('display_name', { ascending: true });

  if (error) {
    console.error('GET /api/admin/crew-accounts:', error.message);
    return NextResponse.json({ error: 'Failed to load crew members' }, { status: 500 });
  }

  const rows = (data as unknown as CrewRow[] | null) ?? [];
  return NextResponse.json({
    crew: rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      active: r.active,
      hasLogin: r.auth_user_id !== null,
      telegramUserId: r.telegram_user_id,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = {
    crewMemberId: String(body?.crewMemberId ?? '').trim(),
    email: String(body?.email ?? '').trim(),
    password: String(body?.password ?? ''),
  };

  const guard = validateCrewAccount(input);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });

  // The crew member must exist and must not already have a login: the unique
  // index would reject a second link anyway, but a clear message beats a 23505.
  const { data: existing, error: lookupError } = await sb
    .from('crew_members')
    .select('id, display_name, active, auth_user_id')
    .eq('id', input.crewMemberId)
    .maybeSingle();

  if (lookupError) {
    console.error('POST /api/admin/crew-accounts lookup:', lookupError.message);
    return NextResponse.json({ error: 'Failed to load the crew member' }, { status: 500 });
  }
  const crew = existing as unknown as CrewRow | null;
  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 404 });
  if (crew.auth_user_id) {
    return NextResponse.json(
      { error: `${crew.display_name} already has a login.` },
      { status: 409 },
    );
  }

  const meta = crewAppMetadata(crew.display_name);
  // Belt and braces: refuse to create anything that would not read as crew.
  if (!crewMetadataIsSafe(meta)) {
    console.error('POST /api/admin/crew-accounts: refusing unsafe crew metadata');
    return NextResponse.json({ error: 'Internal role configuration error' }, { status: 500 });
  }

  const { data: created, error: createError } = await sb.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: meta,
  });

  if (createError || !created?.user) {
    const message = createError?.message ?? 'Failed to create the login';
    console.error('POST /api/admin/crew-accounts create:', message);
    // A duplicate email is the common case and is the caller's to fix.
    const conflict = /already|exists|registered/i.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }

  const authUserId = created.user.id;

  // Link it. If this fails the login would exist unlinked and unusable, so the
  // orphan auth user is deleted rather than left behind to confuse the next admin.
  const { error: linkError } = await sb
    .from('crew_members')
    .update({ auth_user_id: authUserId })
    .eq('id', crew.id)
    .is('auth_user_id', null);

  if (linkError) {
    console.error('POST /api/admin/crew-accounts link:', linkError.message);
    await sb.auth.admin.deleteUser(authUserId).catch(() => {});
    return NextResponse.json(
      { error: 'Created the login but could not link it; the login was rolled back.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    crewMemberId: crew.id,
    displayName: crew.display_name,
    email: input.email,
    linked: true,
  });
}
/**
 * Link (or unlink) a crew member's Telegram account.
 *
 * ADMIN ONLY, same as the rest of this route. The id is written by the office
 * from the admin screen and never accepted from the crew member themselves:
 * whoever holds a Telegram id can clock in as the person it points at, so this
 * is a pay-identity write, not a profile preference.
 *
 * Send `telegramUserId: null` (or an empty string) to unlink.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const crewMemberId = String(body?.crewMemberId ?? '').trim();
  if (!crewMemberId) {
    return NextResponse.json({ error: 'Choose a crew member.' }, { status: 400 });
  }

  const raw = body?.telegramUserId;
  // Absent is NOT the same as null here: null/'' means "unlink", while a missing
  // key means the caller sent nothing to change and is almost certainly a bug.
  if (raw === undefined) {
    return NextResponse.json({ error: 'telegramUserId is required (send null to unlink).' }, { status: 400 });
  }
  const trimmed = raw === null ? '' : String(raw).trim();
  const telegramUserId = trimmed === '' ? null : trimmed;
  if (telegramUserId !== null && !TELEGRAM_USER_ID_RE.test(telegramUserId)) {
    return NextResponse.json(
      {
        error:
          'That is not a Telegram user id. It is a number, not an @handle — the crew member can get theirs from @userinfobot.',
      },
      { status: 400 },
    );
  }

  const { data: existing, error: lookupError } = await sb
    .from('crew_members')
    .select('id, display_name, active, auth_user_id, telegram_user_id')
    .eq('id', crewMemberId)
    .maybeSingle();

  if (lookupError) {
    console.error('PATCH /api/admin/crew-accounts lookup:', lookupError.message);
    return NextResponse.json({ error: 'Failed to load the crew member' }, { status: 500 });
  }
  const crew = existing as unknown as CrewRow | null;
  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 404 });

  try {
    const updated = await updateCrewMember(crewMemberId, { telegramUserId });
    return NextResponse.json({
      crewMemberId: updated.id,
      displayName: updated.displayName,
      telegramUserId: updated.telegramUserId,
    });
  } catch (e) {
    // A partial unique index guards this column, so the conflict is a real
    // "that account already belongs to someone else" — surface it as a 409 the
    // office can act on rather than a generic 500.
    if (e instanceof TelegramUserIdTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('PATCH /api/admin/crew-accounts update:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to update the Telegram link' }, { status: 500 });
  }
}
