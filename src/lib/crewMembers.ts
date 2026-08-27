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

/**
 * Thrown when a staff row cannot be deleted because real work points at it.
 *
 * `shifts`, `shift_breaks`, `job_segments` and `job_assignments` all reference
 * `crew_members` with NO ACTION, so Postgres refuses the delete itself (23503).
 * That refusal is the actual safety property here: it means a person with any
 * recorded time or job history CANNOT be deleted out from under their own
 * payroll, however the delete is attempted.
 */
export class StaffHasRecordsError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} has recorded time or job history, so they cannot be removed. Deactivate them instead, which keeps their records and stops them clocking in.`,
    );
    this.name = 'StaffHasRecordsError';
  }
}

function isForeignKeyViolation(error: { code?: string } | null): boolean {
  return error?.code === '23503';
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
// identity columns (is_office, auth_user_id) are written ONLY through this
// door, never widened into the generic upsert path above.

export type StaffMember = {
  id: string;
  displayName: string;
  active: boolean;
  authUserId: string | null;
  baseRateCents: number;
  telegramUserId: string | null;
  /** true = office staff (operator login), false = field crew (crew login). */
  isOffice: boolean;
};

type StaffRow = {
  id: string;
  display_name: string;
  active: boolean;
  auth_user_id: string | null;
  base_rate_cents: number;
  telegram_user_id: string | null;
  is_office: boolean;
};

// base_rate_cents is selected back (not just written) so the office can SEE the
// rate that was saved and catch a decimal-point typo, and so the rate can be
// edited in-app rather than by hand SQL.
//
// telegram_user_id is here because EVERY staff member texts the bot, not only
// field crew (Naldo's ruling, 2026-08-24). The webhook lookup
// (`getCrewMemberByTelegramUserId`) never filtered on is_office, so the runtime
// always supported this; only the admin doors did not.
//
// is_office is carried as DATA, not as a filter: one Settings panel manages
// every staff member and shows the type as a label, so the same four actions
// (rate, Telegram, password, active) work identically for office and field
// (Naldo's ruling, 2026-08-24: "everything needs to be exactly the same").
const STAFF_SELECT =
  'id, display_name, active, auth_user_id, base_rate_cents, telegram_user_id, is_office';

function toStaffMember(row: StaffRow): StaffMember {
  return {
    id: row.id,
    displayName: row.display_name,
    active: row.active,
    authUserId: row.auth_user_id,
    baseRateCents: row.base_rate_cents,
    telegramUserId: row.telegram_user_id,
    isOffice: row.is_office,
  };
}

/** Every staff pay row, office and field alike, for the one Staff panel. */
export async function listAllStaff(): Promise<StaffMember[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('crew_members')
    .select(STAFF_SELECT)
    .order('display_name', { ascending: true });
  if (error) {
    console.error('listAllStaff error:', error);
    return [];
  }
  return (data ?? []).map((row) => toStaffMember(row as StaffRow));
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
 * Link an existing operator login to a new OFFICE staff pay row. Office staff
 * are hourly and never in the P4P pool. No auth user is created here: the
 * operator already has one, and this only writes the pay identity that ties
 * their session to the time clock.
 */
export async function linkOfficeStaff(input: {
  authUserId: string;
  displayName: string;
  baseRateCents: number;
}): Promise<StaffMember> {
  return insertStaffRow({
    displayName: input.displayName,
    baseRateCents: input.baseRateCents,
    isOffice: true,
    authUserId: input.authUserId,
  });
}

/**
 * Create a FIELD crew pay row. Its login is created and linked separately by the
 * route (a crew auth user), so a row can legitimately exist with no login yet:
 * that is what "No login yet" means in the Staff panel, and it is also the state
 * every hand-seeded crew row was already in.
 */
export async function createFieldCrewMember(input: {
  displayName: string;
  baseRateCents: number;
}): Promise<StaffMember> {
  return insertStaffRow({
    displayName: input.displayName,
    baseRateCents: input.baseRateCents,
    isOffice: false,
    authUserId: null,
  });
}

async function insertStaffRow(input: {
  displayName: string;
  baseRateCents: number;
  isOffice: boolean;
  authUserId: string | null;
}): Promise<StaffMember> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const payload: Record<string, unknown> = {
    display_name: input.displayName.trim(),
    base_rate_cents: input.baseRateCents,
    in_p4p_pool: false,
    pay_mode: 'hourly' as CrewPayMode,
    language: 'en',
    active: true,
    is_office: input.isOffice,
    auth_user_id: input.authUserId,
  };

  const { data, error } = await db.from('crew_members').insert(payload).select(STAFF_SELECT).maybeSingle();
  if (error) {
    // auth_user_id collision is checked FIRST: a lost race to link the same
    // operator is the specific conflict the office needs named, and its message
    // must win over the generic display-name one when both could apply.
    if (isAuthUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new OperatorAlreadyLinkedError();
    }
    if (isDisplayNameUniqueViolation(error as { code?: string; message?: string })) {
      throw new OfficeDisplayNameTakenError(String(payload.display_name));
    }
    throw new Error(`insertStaffRow: ${error.message}`);
  }
  if (!data) throw new Error('insertStaffRow: no row returned');
  return toStaffMember(data as StaffRow);
}

/**
 * Update one staff row by id, office or field alike.
 *
 * There is no is_office filter here BY DESIGN: one panel manages every staff
 * member, so the same four edits (rate, Telegram, password, active) apply to
 * both populations. The earlier office-only filter existed to keep two separate
 * doors from writing each other's rows; with one door that split is gone.
 * Returns null when no row matched the id.
 */
async function patchStaffRow(
  id: string,
  payload: Record<string, unknown>,
): Promise<StaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('crew_members')
    .update(payload)
    .eq('id', id.trim())
    .select(STAFF_SELECT)
    .maybeSingle();
  if (error) {
    // Sibling-guard parity with updateCrewMember: a partial-unique collision on
    // telegram_user_id is a real "that account already belongs to someone else"
    // the office can act on, not a generic write failure. Never recover by
    // returning the other row; that would hand back someone else's pay identity.
    if (isTelegramUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new TelegramUserIdTakenError(String(payload.telegram_user_id));
    }
    throw new Error(`patchStaffRow: ${error.message}`);
  }
  return data ? toStaffMember(data as StaffRow) : null;
}

/** Activate or deactivate any staff member. */
export async function setStaffActive(id: string, active: boolean): Promise<StaffMember | null> {
  return patchStaffRow(id, { active });
}

/**
 * Link (or unlink) any staff member's Telegram account. Pass null to unlink.
 *
 * The webhook resolves a punch through this column, so this is a PAY-IDENTITY
 * write: whoever holds the linked Telegram account can clock in as this person.
 * Admin-only at the route, and never accepted from the staff member themselves.
 */
export async function setStaffTelegram(
  id: string,
  telegramUserId: string | null,
): Promise<StaffMember | null> {
  return patchStaffRow(id, { telegram_user_id: telegramUserId });
}

/** Correct or raise any staff member's hourly rate, in integer cents. */
export async function setStaffRate(id: string, baseRateCents: number): Promise<StaffMember | null> {
  return patchStaffRow(id, { base_rate_cents: baseRateCents });
}

/**
 * Move a staff member between office and field.
 *
 * This exists for RECOVERY, not because office staff go out on jobs (Naldo,
 * 2026-08-24: they never will). Without it a type set wrongly at setup could not
 * be corrected in the app at all — the row cannot simply be re-added, because
 * the display name is unique and the operator no longer appears in the picker
 * once linked, so the only fix was a hand-written UPDATE.
 *
 * The flag's only functional reader is `listActiveFieldCrew`, so this changes
 * exactly one thing: whether they are offered when assigning crew to a job.
 */
export async function setStaffType(id: string, isOffice: boolean): Promise<StaffMember | null> {
  return patchStaffRow(id, { is_office: isOffice });
}

/**
 * Look one staff row up by id, whichever population it is in.
 * Returns null when nothing matches.
 */
export async function getStaffMember(id: string): Promise<StaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('crew_members')
    .select(STAFF_SELECT)
    .eq('id', id.trim())
    .maybeSingle();
  if (error || !data) return null;
  return toStaffMember(data as StaffRow);
}

/**
 * Delete a staff row outright, for a mistake that has no history behind it.
 *
 * This is deliberately NOT the normal way to retire someone: deactivating keeps
 * their pay records, and anyone with recorded time is refused here by the
 * database's own foreign keys (see StaffHasRecordsError). Removal exists for the
 * duplicate or mis-typed row created minutes ago, which otherwise sits in the
 * list forever holding a unique display name.
 *
 * Returns the row that was deleted, or null if the id matched nothing.
 */
export async function deleteStaffMember(id: string): Promise<StaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const existing = await getStaffMember(id);
  if (!existing) return null;

  const { error } = await db.from('crew_members').delete().eq('id', id.trim());
  if (error) {
    if (isForeignKeyViolation(error as { code?: string })) {
      throw new StaffHasRecordsError(existing.displayName);
    }
    throw new Error(`deleteStaffMember: ${error.message}`);
  }
  return existing;
}

/**
 * Detach whatever staff row points at this auth user, BEFORE the auth user is
 * deleted (ledger row 359).
 *
 * `crew_members.auth_user_id` has no foreign key to `auth.users`, so deleting an
 * operator does not clear the pointer on its own. The row was then stuck: it
 * still read as "has a login", and `POST /api/admin/staff` refuses to link a
 * replacement because it only tests the column for truthiness, never whether the
 * id still resolves. The person was locked out until someone ran SQL by hand.
 *
 * Clearing first turns that into an ordinary state: the row shows "No login yet"
 * and can be linked again through the normal flow. Returns the detached row, or
 * null when no row pointed at that login (the common case).
 */
export async function clearStaffLoginByAuthUserId(authUserId: string): Promise<StaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('crew_members')
    .update({ auth_user_id: null })
    .eq('auth_user_id', authUserId.trim())
    .select(STAFF_SELECT)
    .maybeSingle();
  if (error) throw new Error(`clearStaffLoginByAuthUserId: ${error.message}`);
  return data ? toStaffMember(data as StaffRow) : null;
}

/**
 * Detach a staff row's login by the ROW's id, for repairing an orphan that
 * already exists (one created before the clear-on-delete above).
 *
 * The caller MUST have established that the login does not resolve. This
 * function cannot check that itself — it has no view of the auth store — and
 * clearing a LIVE login would lock a working staff member out of the web clock.
 */
export async function clearStaffLogin(id: string): Promise<StaffMember | null> {
  return patchStaffRow(id, { auth_user_id: null });
}

/** Attach a freshly created login to a staff row that has none yet. */
export async function linkStaffLogin(id: string, authUserId: string): Promise<StaffMember | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  // `.is('auth_user_id', null)` makes this a compare-and-swap: if a concurrent
  // admin linked a login first, this matches no row and returns null rather than
  // silently replacing their link and orphaning that auth user.
  const { data, error } = await db
    .from('crew_members')
    .update({ auth_user_id: authUserId })
    .eq('id', id.trim())
    .is('auth_user_id', null)
    .select(STAFF_SELECT)
    .maybeSingle();
  if (error) {
    if (isAuthUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new OperatorAlreadyLinkedError();
    }
    throw new Error(`linkStaffLogin: ${error.message}`);
  }
  return data ? toStaffMember(data as StaffRow) : null;
}
