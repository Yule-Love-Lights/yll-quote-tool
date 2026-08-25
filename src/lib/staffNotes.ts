import { getSupabaseServiceClient } from '@/lib/supabase';

export const STAFF_NOTE_MAX_LENGTH = 2000;

/** Row 373: notes per page. The list was previously unbounded, so a quote with
 *  hundreds of notes fetched every one of them on every panel open. A silent
 *  cap was explicitly rejected when this row was written — it would hide notes
 *  the same way the failed-load-looks-empty bug (#874) did — so the page is
 *  paired with an explicit "hasMore" and a control that fetches the next one. */
export const STAFF_NOTES_PAGE_SIZE = 20;

/** Row 372: what a withdrawn note's body becomes. The row and its attribution
 *  survive — the timeline still shows that something was written and taken
 *  back — but the text itself is gone, which is the whole point of a
 *  redaction. Deliberately a plain sentence rather than a marker string: it is
 *  read by staff on a customer's timeline, not parsed. */
export const REDACTED_NOTE_BODY = '[Note withdrawn]';

/** Row 372: the longest reason we will store. Same order as the note body's
 *  own limit; a reason is prose, not an essay. */
export const STAFF_NOTE_REASON_MAX_LENGTH = 500;

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
  /** Row 372: non-null when this note was withdrawn — `body` is then the
   *  tombstone, not what was written. */
  redactedAt: string | null;
  redactedByLabel: string | null;
  redactedReason: string | null;
};

type StaffNoteRow = {
  id: string;
  quote_id: string;
  body: string;
  created_by: string | null;
  created_by_label: string;
  created_at: string;
  client_request_id: string;
  redacted_at: string | null;
  redacted_by_label: string | null;
  redacted_reason: string | null;
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
  'id, quote_id, body, created_by, created_by_label, created_at, client_request_id, ' +
  'redacted_at, redacted_by_label, redacted_reason';

function toStaffNote(row: StaffNoteRow): StaffNote {
  return {
    id: row.id,
    quoteId: row.quote_id,
    body: row.body,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    redactedAt: row.redacted_at ?? null,
    redactedByLabel: row.redacted_by_label ?? null,
    redactedReason: row.redacted_reason ?? null,
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
  // `as unknown` first: the multi-line select string (row 372 widened it past
  // what postgrest-js's literal-type inference follows) makes it infer an error
  // shape rather than the row shape.
  const rows = (data ?? []) as unknown as StaffNoteRow[];
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

export type RedactStaffNoteInput = {
  quoteId: string;
  noteId: string;
  redactedBy: string;
  redactedByLabel: string;
  reason: string | null;
};

export type RedactStaffNoteResult =
  | { kind: 'redacted'; note: StaffNote }
  | { kind: 'already-redacted'; note: StaffNote }
  | { kind: 'not-found' | 'error' };

/**
 * Row 372: withdraw a note. The row stays, its author and timestamp stay, and
 * the body becomes a tombstone.
 *
 * Guarded the way this module's other writer is (appendStaffNote's unique
 * (quote_id, client_request_id) key, and the sibling-guard parity rule in
 * AGENTS.md): the update is scoped to `quote_id` AND conditioned on
 * `redacted_at is null`, so
 *   • a note id from another quote cannot be redacted through this quote, and
 *   • a second click cannot overwrite the FIRST redaction's attribution and
 *     timestamp with a later staffer's — the original withdrawal is the one
 *     that happened, and it is what the timeline should keep saying.
 * A zero-row update is therefore ambiguous by design, so it is disambiguated
 * with a read rather than reported as a failure: already-withdrawn is a
 * success from the caller's point of view, and a genuinely missing note is
 * not the same answer.
 */
export async function redactStaffNote(input: RedactStaffNoteInput): Promise<RedactStaffNoteResult> {
  const db = getSupabaseServiceClient();
  if (!db) return { kind: 'error' };

  const reason = input.reason?.trim() ? input.reason.trim().slice(0, STAFF_NOTE_REASON_MAX_LENGTH) : null;
  const { data, error } = await db
    .from('staff_notes')
    .update({
      body: REDACTED_NOTE_BODY,
      redacted_at: new Date().toISOString(),
      redacted_by: input.redactedBy,
      redacted_by_label: input.redactedByLabel,
      redacted_reason: reason,
    })
    .eq('id', input.noteId)
    .eq('quote_id', input.quoteId)
    .is('redacted_at', null)
    .select(STAFF_NOTE_COLUMNS)
    .maybeSingle<StaffNoteRow>();

  if (error) {
    console.error('[staff-notes] redact failed', error.message);
    return { kind: 'error' };
  }
  if (data) return { kind: 'redacted', note: toStaffNote(data) };

  // Nothing was updated: either the note is not on this quote, or it was
  // already withdrawn. Read it back to say which.
  const { data: existing, error: lookupError } = await db
    .from('staff_notes')
    .select(STAFF_NOTE_COLUMNS)
    .eq('id', input.noteId)
    .eq('quote_id', input.quoteId)
    .maybeSingle<StaffNoteRow>();
  if (lookupError) {
    console.error('[staff-notes] redact lookup failed', lookupError.message);
    return { kind: 'error' };
  }
  if (!existing) return { kind: 'not-found' };
  return { kind: 'already-redacted', note: toStaffNote(existing) };
}
