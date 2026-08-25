import { getSupabaseServiceClient } from '@/lib/supabase';

export const STAFF_NOTE_MAX_LENGTH = 2000;

/** Row 373: notes per page. The list was previously unbounded, so a quote with
 *  hundreds of notes fetched every one of them on every panel open. A silent
 *  cap was explicitly rejected when this row was written — it would hide notes
 *  the same way the failed-load-looks-empty bug (#874) did — so the page is
 *  paired with an explicit "hasMore" and a control that fetches the next one. */
export const STAFF_NOTES_PAGE_SIZE = 20;

/** Row 373: where the NEXT page starts. Keyset, not offset: notes are
 *  append-only and read newest-first, so an offset window would silently SKIP a
 *  note whenever one was added between two page reads — the exact class of
 *  quiet omission this row exists to avoid. */
export type StaffNoteCursor = { createdAt: string; id: string };

export type StaffNotesPage = { notes: StaffNote[]; hasMore: boolean };

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

export async function listStaffNotes(
  quoteId: string,
  before?: StaffNoteCursor | null,
): Promise<StaffNotesPage | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  let query = db.from('staff_notes').select(STAFF_NOTE_COLUMNS).eq('quote_id', quoteId);
  if (before) {
    // Strictly older than the cursor row under the SAME (created_at desc, id
    // desc) ordering used below. The `id` half is not decoration: two notes can
    // share a created_at, and without the tiebreaker one of them would either
    // repeat on the next page or vanish from both. Values are double-quoted so
    // a timestamp's own punctuation can never be read as PostgREST syntax.
    query = query.or(
      `created_at.lt."${before.createdAt}",and(created_at.eq."${before.createdAt}",id.lt."${before.id}")`,
    );
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    // One MORE than the page, purely to answer "is there another page?" without
    // a second count query. The extra row is sliced off below and never shown.
    .limit(STAFF_NOTES_PAGE_SIZE + 1);
  if (error) {
    console.error('[staff-notes] list failed', error.message);
    return null;
  }
  const rows = (data ?? []) as StaffNoteRow[];
  const hasMore = rows.length > STAFF_NOTES_PAGE_SIZE;
  return { notes: rows.slice(0, STAFF_NOTES_PAGE_SIZE).map(toStaffNote), hasMore };
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
