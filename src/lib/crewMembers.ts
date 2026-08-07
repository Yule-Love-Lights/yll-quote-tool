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
  createdAt: string | null;
  updatedAt: string | null;
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
  created_at: string | null;
  updated_at: string | null;
};

const SELECT =
  'id, hub_employee_id, telegram_user_id, display_name, base_rate_cents, in_p4p_pool, pay_mode, language, active, created_at, updated_at';

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

export async function insertCrewMember(input: NewCrewMemberInput): Promise<CrewMember> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const payload = buildCrewMemberInsertPayload(input);

  const { data, error } = await db.from('crew_members').insert(payload).select(SELECT).maybeSingle();
  if (error || !data) throw new Error(`insertCrewMember: ${error?.message ?? 'no row returned'}`);
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
  if (error) throw new Error(`updateCrewMember: ${error.message}`);
  if (!data) throw new Error(`updateCrewMember: no row found for id ${crewMemberId}`);
  return toCrewMember(data as Row);
}
