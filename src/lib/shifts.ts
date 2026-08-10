import { getSupabaseServiceClient } from '@/lib/supabase';

export type ShiftSource = 'pwa' | 'telegram' | 'office' | 'system';

export type Shift = {
  id: string;
  crewMemberId: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: ShiftSource;
  closeSource: ShiftSource | null;
  deviceTime: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type Row = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: ShiftSource;
  close_source: ShiftSource | null;
  device_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const SELECT =
  'id, crew_member_id, clock_in_at, clock_out_at, source, close_source, device_time, created_at, updated_at';

function toShift(row: Row): Shift {
  return {
    id: row.id,
    crewMemberId: row.crew_member_id,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    source: row.source,
    closeSource: row.close_source,
    deviceTime: row.device_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isOpenShiftUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('shifts_one_open_per_person') === true;
}

async function getOpenShiftRow(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  crewMemberId: string,
): Promise<Row | null> {
  const { data, error } = await db
    .from('shifts')
    .select(SELECT)
    .eq('crew_member_id', crewMemberId)
    .is('clock_out_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenShift: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function getShiftRowById(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  shiftId: string,
): Promise<Row | null> {
  const { data, error } = await db.from('shifts').select(SELECT).eq('id', shiftId).maybeSingle();
  if (error) throw new Error(`clockOut: ${error.message}`);
  return (data as Row | null) ?? null;
}

export async function getOpenShift(crewMemberId: string): Promise<Shift | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  try {
    const row = await getOpenShiftRow(db, crewMemberId.trim());
    return row ? toShift(row) : null;
  } catch (error) {
    console.error('getOpenShift error:', error);
    return null;
  }
}

export async function clockIn(crewMemberId: string, source: ShiftSource): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedCrewMemberId = crewMemberId.trim();
  const existing = await getOpenShiftRow(db, trimmedCrewMemberId);
  if (existing) return toShift(existing);

  const { data, error } = await db
    .from('shifts')
    .insert({
      crew_member_id: trimmedCrewMemberId,
      source,
    })
    .select(SELECT)
    .maybeSingle();

  if (error) {
    if (isOpenShiftUniqueViolation(error as { code?: string; message?: string })) {
      const winner = await getOpenShiftRow(db, trimmedCrewMemberId);
      if (winner) return toShift(winner);
    }
    throw new Error(`clockIn: ${error.message}`);
  }
  if (!data) throw new Error(`clockIn: no row returned for crew member ${trimmedCrewMemberId}`);
  return toShift(data as Row);
}

export async function clockOut(
  shiftId: string,
  crewMemberId: string,
  source: ShiftSource,
): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedShiftId = shiftId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('shifts')
    .update({ clock_out_at: now, close_source: source })
    .eq('id', trimmedShiftId)
    .eq('crew_member_id', trimmedCrewMemberId)
    .is('clock_out_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`clockOut: ${error.message}`);
  if (data) return toShift(data as Row);

  const row = await getShiftRowById(db, trimmedShiftId);
  if (!row) throw new Error(`clockOut: no shift found for id ${trimmedShiftId}`);
  if (row.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(`clockOut: shift ${trimmedShiftId} belongs to ${row.crew_member_id}, not ${trimmedCrewMemberId}`);
  }
  if (row.clock_out_at) throw new Error(`clockOut: shift ${trimmedShiftId} is already closed`);
  throw new Error(`clockOut: shift ${trimmedShiftId} could not be closed`);
}
