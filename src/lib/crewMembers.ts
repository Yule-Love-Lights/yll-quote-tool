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
    throw new Error(`updateCrewMember: ${error.message}`);
  }
  if (!data) throw new Error(`updateCrewMember: no row found for id ${crewMemberId}`);
  return toCrewMember(data as Row);
}
