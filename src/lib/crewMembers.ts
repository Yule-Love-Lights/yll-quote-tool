import { getSupabaseServiceClient } from '@/lib/supabase';

export type CrewPayMode = 'hourly' | 'shadow' | 'p4p';

export type CrewMember = {
  id: string;
  hubEmployeeId: string | null;
  telegramUserId: string | null;
  displayName: string;
  baseRateCents: number;
  inP4pPool: boolean;
  payMode: CrewPayMode;
  language: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CrewMemberUpsertFields = {
  hubEmployeeId?: string | null;
  telegramUserId?: string | null;
  displayName: string;
  baseRateCents: number;
  inP4pPool: boolean;
  payMode: CrewPayMode;
  language?: string;
  active?: boolean;
};

export type NewCrewMemberInput = CrewMemberUpsertFields;

type Row = {
  id: string;
  hub_employee_id: string | null;
  telegram_user_id: string | null;
  display_name: string;
  base_rate_cents: number;
  in_p4p_pool: boolean;
  pay_mode: CrewPayMode;
  language: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT =
  'id, hub_employee_id, telegram_user_id, display_name, base_rate_cents, in_p4p_pool, pay_mode, language, active, created_at, updated_at';

function isDisplayNameUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('crew_members_display_name_key') === true;
}

/**
 * The OTHER unique index on this table (`crew_members_telegram_user_id_key`,
 * partial: `where telegram_user_id is not null`).
 *
 * Sibling-guard parity with the display-name check above. Linking a Telegram
 * account that already belongs to a DIFFERENT crew member is a real conflict,
 * and the caller has to be able to tell it apart from a generic write failure —
 * "that Telegram account is already linked to someone else" is fixable by the
 * office, "update failed" is not.
 */
function isTelegramUserIdUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('crew_members_telegram_user_id_key') === true;
}

/**
 * The `crew_members_auth_user_id_key` partial unique index
 * (`where auth_user_id is not null`). Linking an operator who is already linked
 * to a crew_members row is a real conflict the office can act on ("that person
 * is already set up"), distinct from a generic write failure.
 */
function isAuthUserIdUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('crew_members_auth_user_id_key') === true;
}

/** Thrown when a patch would give one Telegram account to two crew members. */
export class TelegramUserIdTakenError extends Error {
  constructor(telegramUserId: string) {
    super(`Telegram account ${telegramUserId} is already linked to another crew member`);
    this.name = 'TelegramUserIdTakenError';
  }
}

/** Thrown when an operator is already linked to a crew_members pay row. */
export class OperatorAlreadyLinkedError extends Error {
  constructor() {
    super('That operator is already set up as staff.');
    this.name = 'OperatorAlreadyLinkedError';
  }
}

/** Thrown when an office-staff display name collides with an existing row. */
export class OfficeDisplayNameTakenError extends Error {
  constructor(displayName: string) {
    super(`The name "${displayName}" is already in use by another staff member. Choose a different display name.`);
    this.name = 'OfficeDisplayNameTakenError';
  }
}

function buildCrewMemberInsertPayload(input: NewCrewMemberInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    display_name: input.displayName.trim(),
    base_rate_cents: input.baseRateCents,
    in_p4p_pool: input.inP4pPool,
    pay_mode: input.payMode,
    language: input.language?.trim() || 'en',
    active: input.active ?? true,
  };

  if (input.hubEmployeeId !== undefined) payload.hub_employee_id = input.hubEmployeeId?.trim() || null;
  if (input.telegramUserId !== undefined) payload.telegram_user_id = input.telegramUserId?.trim() || null;

  return payload;
}

function buildCrewMemberUpdatePayload(patch: Partial<CrewMemberUpsertFields>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (patch.displayName !== undefined) payload.display_name = patch.displayName.trim();
  if (patch.baseRateCents !== undefined) payload.base_rate_cents = patch.baseRateCents;
  if (patch.inP4pPool !== undefined) payload.in_p4p_pool = patch.inP4pPool;
  if (patch.payMode !== undefined) payload.pay_mode = patch.payMode;
  if (patch.language !== undefined) payload.language = patch.language.trim() || 'en';
  if (patch.active !== undefined) payload.active = patch.active;
  if (patch.hubEmployeeId !== undefined) payload.hub_employee_id = patch.hubEmployeeId?.trim() || null;
  if (patch.telegramUserId !== undefined) payload.telegram_user_id = patch.telegramUserId?.trim() || null;

  return payload;
}

function toCrewMember(row: Row): CrewMember {
  return {
    id: row.id,
    hubEmployeeId: row.hub_employee_id,
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    baseRateCents: row.base_rate_cents,
    inP4pPool: row.in_p4p_pool,
    payMode: row.pay_mode,
    language: row.language,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCrewMember(id: string): Promise<CrewMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db.from('crew_members').select(SELECT).eq('id', id.trim()).maybeSingle();
  if (error || !data) return null;
  return toCrewMember(data as Row);
}

export async function getCrewMemberByTelegramUserId(telegramUserId: string): Promise<CrewMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('crew_members')
    .select(SELECT)
    .eq('telegram_user_id', telegramUserId.trim())
    .maybeSingle();
  if (error || !data) return null;
  return toCrewMember(data as Row);
}

export async function listActiveCrewMembers(): Promise<CrewMember[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('crew_members')
    .select(SELECT)
    .eq('active', true)
    .order('display_name', { ascending: true });
  if (error) {
    console.error('listActiveCrewMembers error:', error);
    return [];
  }
  return (data ?? []).map((row) => toCrewMember(row as Row));
}

/**
 * Active FIELD crew only — excludes office staff (`is_office = true`).
 *
 * This is the roster for JOB ASSIGNMENT (the schedule / dispatch dropdowns).
 * Office staff (Naldo, Kelly, ...) are operators, not installers, and must never
 * be offered as assignable crew for a job. Payroll and the full-roster views use
 * `listActiveCrewMembers`, which INCLUDES office staff — office people still
 * accrue hours, they just are not dispatchable field crew. Keep the two apart:
 * filtering the shared `listActiveCrewMembers` would silently drop office hours
 * from payroll.
 */
export async function listActiveFieldCrew(): Promise<CrewMember[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('crew_members')
    .select(SELECT)
    .eq('active', true)
    .eq('is_office', false)
    .order('display_name', { ascending: true });
  if (error) {
    console.error('listActiveFieldCrew error:', error);
    return [];
  }
  return (data ?? []).map((row) => toCrewMember(row as Row));
}

// insertCrewMember has no `id` in its input by design (that's the whole
// point of the insert/update split — see the review that split them), so it
// cannot check "does this id already exist" before inserting. The one race
// the crew_members_display_name_key migration itself names as the threat
// model — two concurrent no-id insert calls for the same person — is only
// closed HERE, by catching that specific unique-violation and re-fetching the
// winner, mirroring shifts.ts's clockIn (same session, same race shape).
export async function insertCrewMember(input: NewCrewMemberInput): Promise<CrewMember> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const payload = buildCrewMemberInsertPayload(input);

  const { data, error } = await db.from('crew_members').insert(payload).select(SELECT).maybeSingle();
  if (error) {
    if (isDisplayNameUniqueViolation(error as { code?: string; message?: string })) {
      const { data: winner, error: refetchError } = await db
        .from('crew_members')
        .select(SELECT)
        .ilike('display_name', String(payload.display_name))
        .maybeSingle();
      if (!refetchError && winner) return toCrewMember(winner as Row);
    }
    throw new Error(`insertCrewMember: ${error.message}`);
  }
  if (!data) throw new Error('insertCrewMember: no row returned');
  return toCrewMember(data as Row);
}

export async function updateCrewMember(
  id: string,
  patch: Partial<CrewMemberUpsertFields>,
): Promise<CrewMember> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const crewMemberId = id.trim();
  const payload = buildCrewMemberUpdatePayload(patch);

  const { data, error } = await db.from('crew_members').update(payload).eq('id', crewMemberId).select(SELECT).maybeSingle();
  if (error) {
    // Unlike insertCrewMember's race, a rename-to-duplicate collision here is
    // a genuine conflict (this person's name, colliding with a DIFFERENT
    // existing person) — never "recover" by returning the other row, that
    // would silently hand back someone else's data as if it were this
    // update's result. Surface a clear, specific error instead.
    if (isDisplayNameUniqueViolation(error as { code?: string; message?: string })) {
      throw new Error(
        `updateCrewMember: display name "${String(payload.display_name)}" is already in use by another crew member`,
      );
    }
    if (isTelegramUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new TelegramUserIdTakenError(String(payload.telegram_user_id));
    }
    throw new Error(`updateCrewMember: ${error.message}`);
  }
  if (!data) throw new Error(`updateCrewMember: no row found for id ${crewMemberId}`);
  return toCrewMember(data as Row);
}

// --- Office staff (is_office = true) -------------------------------------------
//
// Office staff (Naldo, Kelly, Ann, ...) sign in with an OPERATOR login and clock
// in on the office web clock. Their pay identity is a crew_members row with
// is_office=true and auth_user_id pointing at that operator login — the row
// getOfficeClockCaller resolves a punch through. These three functions are the
// app-side replacement for creating that row by hand in SQL (ledger #354). They
// are deliberately separate from the general insert/update above so the
// office-only columns (is_office, auth_user_id) are written ONLY through this
// door, never widened into the field-crew upsert path.

export type OfficeStaffMember = {
  id: string;
  displayName: string;
  active: boolean;
  authUserId: string | null;
};

type OfficeRow = { id: string; display_name: string; active: boolean; auth_user_id: string | null };

const OFFICE_SELECT = 'id, display_name, active, auth_user_id';

function toOfficeStaffMember(row: OfficeRow): OfficeStaffMember {
  return { id: row.id, displayName: row.display_name, active: row.active, authUserId: row.auth_user_id };
}

/** Every office-staff pay row (is_office = true), for the onboarding panel. */
export async function listOfficeStaff(): Promise<OfficeStaffMember[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('crew_members')
    .select(OFFICE_SELECT)
    .eq('is_office', true)
    .order('display_name', { ascending: true });
  if (error) {
    console.error('listOfficeStaff error:', error);
    return [];
  }
  return (data ?? []).map((row) => toOfficeStaffMember(row as OfficeRow));
}

/**
 * The auth_user_id of EVERY crew_members row that has one — field crew AND office
 * staff. An operator already in this set is already linked to a pay row and must
 * not be offered again in the onboarding picker, nor linked a second time.
 */
export async function listLinkedAuthUserIds(): Promise<Set<string>> {
  const db = getSupabaseServiceClient();
  if (!db) return new Set();
  const { data, error } = await db
    .from('crew_members')
    .select('auth_user_id')
    .order('display_name', { ascending: true });
  if (error) {
    console.error('listLinkedAuthUserIds error:', error);
    return new Set();
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as { auth_user_id: string | null }[]) {
    if (row.auth_user_id) ids.add(row.auth_user_id);
  }
  return ids;
}

/**
 * Link an existing operator login to a new office-staff pay row. Office staff are
 * hourly and never in the P4P pool. No auth user is created here — the operator
 * already has one; this only writes the pay identity that ties their session to
 * the time clock.
 */
export async function linkOfficeStaff(input: {
  authUserId: string;
  displayName: string;
  baseRateCents: number;
}): Promise<OfficeStaffMember> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const payload = {
    display_name: input.displayName.trim(),
    base_rate_cents: input.baseRateCents,
    in_p4p_pool: false,
    pay_mode: 'hourly' as CrewPayMode,
    language: 'en',
    active: true,
    is_office: true,
    auth_user_id: input.authUserId,
  };

  const { data, error } = await db.from('crew_members').insert(payload).select(OFFICE_SELECT).maybeSingle();
  if (error) {
    // auth_user_id collision is checked FIRST: a lost race to link the same
    // operator is the specific conflict the office needs named, and its message
    // must win over the generic display-name one when both could apply.
    if (isAuthUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new OperatorAlreadyLinkedError();
    }
    if (isDisplayNameUniqueViolation(error as { code?: string; message?: string })) {
      throw new OfficeDisplayNameTakenError(payload.display_name);
    }
    throw new Error(`linkOfficeStaff: ${error.message}`);
  }
  if (!data) throw new Error('linkOfficeStaff: no row returned');
  return toOfficeStaffMember(data as OfficeRow);
}

/**
 * Activate or deactivate an OFFICE staff member. The `is_office = true` filter is
 * part of the write, not a separate read-then-check: a field-crew id simply
 * matches no row and returns null, so this can never toggle `active` on a field
 * crew member (who are managed on the crew panel, not here). Returns null when no
 * office row matched.
 */
export async function setOfficeStaffActive(id: string, active: boolean): Promise<OfficeStaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('crew_members')
    .update({ active })
    .eq('id', id.trim())
    .eq('is_office', true)
    .select(OFFICE_SELECT)
    .maybeSingle();
  if (error) throw new Error(`setOfficeStaffActive: ${error.message}`);
  return data ? toOfficeStaffMember(data as OfficeRow) : null;
}
