import { getSupabaseServiceClient } from '@/lib/supabase';

export const STAFF_NOTE_MAX_LENGTH = 2000;

export type StaffNote = {
  id: string;
  quoteId: string;
  body: string;
  createdBy: string | null;
  createdByLabel: string;
  createdAt: string;
};

type StaffNoteRow = {
  id: string;
  quote_id: string;
  body: string;
  created_by: string | null;
  created_by_label: string;
  created_at: string;
  client_request_id: string;
};

type AppendStaffNoteInput = {
  quoteId: string;
  body: string;
  createdBy: string;
  createdByLabel: string;
  clientRequestId: string;
};

export type AppendStaffNoteResult =
  | { kind: 'created' | 'duplicate'; note: StaffNote }
  | { kind: 'conflict' | 'not-found' | 'error' };

const STAFF_NOTE_COLUMNS =
  'id, quote_id, body, created_by, created_by_label, created_at, client_request_id';

function toStaffNote(row: StaffNoteRow): StaffNote {
  return {
    id: row.id,
    quoteId: row.quote_id,
    body: row.body,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
  };
}

export async function quoteExistsForStaffNotes(quoteId: string): Promise<boolean | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db.from('quotes').select('id').eq('id', quoteId).maybeSingle<{ id: string }>();
  if (error) {
    console.error('[staff-notes] quote lookup failed', error.message);
    return null;
  }
  return !!data;
}

export async function listStaffNotes(quoteId: string): Promise<StaffNote[] | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('staff_notes')
    .select(STAFF_NOTE_COLUMNS)
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) {
    console.error('[staff-notes] list failed', error.message);
    return null;
  }
  return ((data ?? []) as StaffNoteRow[]).map(toStaffNote);
}

export async function appendStaffNote(input: AppendStaffNoteInput): Promise<AppendStaffNoteResult> {
  const db = getSupabaseServiceClient();
  if (!db) return { kind: 'error' };

  const { data, error } = await db
    .from('staff_notes')
    .insert({
      quote_id: input.quoteId,
      body: input.body,
      created_by: input.createdBy,
      created_by_label: input.createdByLabel,
      client_request_id: input.clientRequestId,
    })
    .select(STAFF_NOTE_COLUMNS)
    .single<StaffNoteRow>();

  if (!error && data) return { kind: 'created', note: toStaffNote(data) };
  if (error?.code === '23503') return { kind: 'not-found' };
  if (error?.code !== '23505') {
    console.error('[staff-notes] append failed', error?.message ?? 'missing inserted row');
    return { kind: 'error' };
  }

  // A response-lost retry reaches the unique (quote_id, client_request_id)
  // constraint. Return the original row only when its immutable payload and
  // author match; reusing the key for different content is a conflict.
  const { data: existing, error: lookupError } = await db
    .from('staff_notes')
    .select(STAFF_NOTE_COLUMNS)
    .eq('quote_id', input.quoteId)
    .eq('client_request_id', input.clientRequestId)
    .maybeSingle<StaffNoteRow>();
  if (lookupError || !existing) {
    console.error('[staff-notes] retry lookup failed', lookupError?.message ?? 'missing existing row');
    return { kind: 'error' };
  }
  if (existing.body !== input.body || existing.created_by !== input.createdBy) {
    return { kind: 'conflict' };
  }
  return { kind: 'duplicate', note: toStaffNote(existing) };
}
