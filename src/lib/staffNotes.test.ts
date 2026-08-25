import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serviceClientRef } = vi.hoisted(() => ({
  serviceClientRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => serviceClientRef.current,
}));

import {
  REDACTED_NOTE_BODY,
  mayRedactStaffNote,
  STAFF_NOTES_PAGE_SIZE,
  appendStaffNote,
  redactStaffNote,
  listStaffNotes,
  quoteExistsForStaffNotes,
} from './staffNotes';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

const ROW = {
  id: '44444444-4444-4444-8444-444444444444',
  quote_id: QUOTE_ID,
  body: 'Gate code is in the lockbox.',
  created_by: OPERATOR_ID,
  created_by_label: 'Naldo',
  created_at: '2026-08-21T14:00:00.000Z',
  client_request_id: REQUEST_ID,
  // Row 372: an ordinary note that was never withdrawn.
  redacted_at: null,
  redacted_by_label: null,
  redacted_reason: null,
};

function terminalBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    // Row 373: keyset paging — `or` carries the cursor, `limit` the page size.
    or: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    // Row 372: redaction writes through `update` and guards on `is`.
    update: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientRef.current = null;
});

describe('quoteExistsForStaffNotes', () => {
  it('distinguishes a missing quote from a database failure', async () => {
    const present = terminalBuilder({ data: { id: QUOTE_ID }, error: null });
    const missing = terminalBuilder({ data: null, error: null });
    const failed = terminalBuilder({ data: null, error: { message: 'db down' } });
    const from = vi
      .fn()
      .mockReturnValueOnce(present)
      .mockReturnValueOnce(missing)
      .mockReturnValueOnce(failed);
    serviceClientRef.current = { from };

    await expect(quoteExistsForStaffNotes(QUOTE_ID)).resolves.toBe(true);
    await expect(quoteExistsForStaffNotes(QUOTE_ID)).resolves.toBe(false);
    await expect(quoteExistsForStaffNotes(QUOTE_ID)).resolves.toBeNull();
  });
});

describe('listStaffNotes', () => {
  it('maps database rows and requests newest-first order', async () => {
    const query = terminalBuilder({ data: [ROW], error: null });
    serviceClientRef.current = { from: vi.fn(() => query) };

    await expect(listStaffNotes(QUOTE_ID)).resolves.toEqual({
      notes: [
        {
          id: ROW.id,
          quoteId: QUOTE_ID,
          body: ROW.body,
          createdBy: OPERATOR_ID,
          createdByLabel: 'Naldo',
          createdAt: ROW.created_at,
          redactedAt: null,
          redactedByLabel: null,
          redactedReason: null,
        },
      ],
      hasMore: false,
    });
    expect(query.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
    // Row 373: no cursor filter on the first page.
    expect(query.or).not.toHaveBeenCalled();
  });

  // ── Row 373: paging ───────────────────────────────────────────────────────
  // The list was unbounded, so a quote with hundreds of notes fetched all of
  // them on every panel open. A silent cap was rejected when this row was
  // written (it hides notes), so the page is paired with an explicit hasMore.
  const rowsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...ROW,
      id: `${i}`.padStart(8, '0') + '-4444-4444-8444-444444444444',
      created_at: new Date(Date.parse(ROW.created_at) - i * 1000).toISOString(),
    }));

  it('asks for one row MORE than the page, and reports hasMore without returning the extra', async () => {
    const query = terminalBuilder({ data: rowsOf(STAFF_NOTES_PAGE_SIZE + 1), error: null });
    serviceClientRef.current = { from: vi.fn(() => query) };

    const page = await listStaffNotes(QUOTE_ID);

    expect(query.limit).toHaveBeenCalledWith(STAFF_NOTES_PAGE_SIZE + 1);
    expect(page?.notes).toHaveLength(STAFF_NOTES_PAGE_SIZE);
    expect(page?.hasMore).toBe(true);
  });

  it('reports hasMore false when the page is not full', async () => {
    const query = terminalBuilder({ data: rowsOf(3), error: null });
    serviceClientRef.current = { from: vi.fn(() => query) };

    const page = await listStaffNotes(QUOTE_ID);
    expect(page?.notes).toHaveLength(3);
    expect(page?.hasMore).toBe(false);
  });

  // A full page with nothing behind it must not advertise a next page that
  // would come back empty.
  it('reports hasMore false when the page is exactly full', async () => {
    const query = terminalBuilder({ data: rowsOf(STAFF_NOTES_PAGE_SIZE), error: null });
    serviceClientRef.current = { from: vi.fn(() => query) };

    expect((await listStaffNotes(QUOTE_ID))?.hasMore).toBe(false);
  });

  it('filters strictly older than the cursor, tie-breaking on id for notes sharing an instant', async () => {
    const query = terminalBuilder({ data: [], error: null });
    serviceClientRef.current = { from: vi.fn(() => query) };

    await listStaffNotes(QUOTE_ID, { createdAt: ROW.created_at, id: ROW.id });

    expect(query.or).toHaveBeenCalledWith(
      `created_at.lt."${ROW.created_at}",and(created_at.eq."${ROW.created_at}",id.lt."${ROW.id}")`,
    );
  });

  it('returns null (not an empty page) when the read fails, so the panel can say so', async () => {
    const query = terminalBuilder({ data: null, error: { message: 'db down' } });
    serviceClientRef.current = { from: vi.fn(() => query) };

    await expect(listStaffNotes(QUOTE_ID)).resolves.toBeNull();
  });
});

// ─── Row 372: withdrawing a note ────────────────────────────────────────────
// staff_notes is append-only down to the grants, so the only way to remove a
// note written in error — or one naming someone who should not be named — was
// to delete the whole quote. This is a tombstone instead: the row and its
// attribution survive, the text does not.
// Admin lens HIGH: withdrawing is irreversible and total — nothing anywhere
// keeps the original text — so "any operator may erase any note" was the wrong
// default, and out of step with this repo gating irreversible actions on
// requireAdmin. Requiring an admin for ALL of them is also wrong: the common
// case is someone fixing their own mistake, which should not wait on the owner.
describe('mayRedactStaffNote (row 372 — who may erase)', () => {
  const ME = OPERATOR_ID;
  const SOMEONE_ELSE = '55555555-5555-4555-8555-555555555555';

  it('lets a staffer withdraw their OWN note', () => {
    expect(mayRedactStaffNote({ actorId: ME, actorRole: 'operator', noteAuthorId: ME })).toBe(true);
  });

  it('refuses a staffer withdrawing someone ELSE s note', () => {
    expect(mayRedactStaffNote({ actorId: ME, actorRole: 'operator', noteAuthorId: SOMEONE_ELSE })).toBe(false);
  });

  it('lets an admin withdraw anyone s note', () => {
    expect(mayRedactStaffNote({ actorId: ME, actorRole: 'admin', noteAuthorId: SOMEONE_ELSE })).toBe(true);
  });

  // created_by goes null when an account is deleted. An orphaned note is
  // nobody's own note, so it takes an admin rather than becoming everybody's.
  it('treats an authorless note as admin-only', () => {
    expect(mayRedactStaffNote({ actorId: ME, actorRole: 'operator', noteAuthorId: null })).toBe(false);
    expect(mayRedactStaffNote({ actorId: ME, actorRole: 'admin', noteAuthorId: null })).toBe(true);
  });
});

describe('redactStaffNote (row 372)', () => {
  const REDACTED_ROW = {
    ...ROW,
    body: REDACTED_NOTE_BODY,
    redacted_at: '2026-08-25T10:00:00.000Z',
    redacted_by_label: 'Jason',
    redacted_reason: 'Wrong customer',
  };

  // The writer reads the note first (to check the author-or-admin rule against
  // the row's REAL author), then writes — so these fakes hand out the read
  // builder first and the update builder second.
  const twoStep = (read: unknown, write: unknown) => {
    const readB = terminalBuilder({ data: read, error: null });
    const writeB = terminalBuilder({ data: write, error: null });
    let call = 0;
    serviceClientRef.current = { from: vi.fn(() => (call++ === 0 ? readB : writeB)) };
    return { readB, writeB };
  };

  it('replaces the body with the tombstone and stamps who withdrew it', async () => {
    const { writeB: query } = twoStep(ROW, REDACTED_ROW);

    const result = await redactStaffNote({
      quoteId: QUOTE_ID,
      noteId: ROW.id,
      redactedBy: OPERATOR_ID,
      redactedByLabel: 'Jason',
      redactedByRole: 'admin',
      reason: '  Wrong customer  ',
    });

    expect(result.kind).toBe('redacted');
    const payload = (query.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.body).toBe(REDACTED_NOTE_BODY);
    expect(payload.redacted_by).toBe(OPERATOR_ID);
    expect(payload.redacted_by_label).toBe('Jason');
    expect(payload.redacted_reason).toBe('Wrong customer'); // trimmed
    // The note's OWN identity is never part of the write — the column grant
    // refuses it too, but nothing should be trying.
    expect(payload).not.toHaveProperty('created_by');
    expect(payload).not.toHaveProperty('created_at');
    expect(payload).not.toHaveProperty('client_request_id');
    expect(payload).not.toHaveProperty('quote_id');
  });

  it('scopes the write to the quote AND to a note that is not already withdrawn', async () => {
    const { readB, writeB: query } = twoStep(ROW, REDACTED_ROW);

    await redactStaffNote({
      quoteId: QUOTE_ID,
      noteId: ROW.id,
      redactedBy: OPERATOR_ID,
      redactedByLabel: 'Jason',
      redactedByRole: 'admin',
      reason: null,
    });

    const eqCalls = (query.eq as ReturnType<typeof vi.fn>).mock.calls;
    expect(eqCalls).toContainEqual(['id', ROW.id]);
    expect(eqCalls).toContainEqual(['quote_id', QUOTE_ID]); // no cross-quote redaction
    expect((query.is as ReturnType<typeof vi.fn>).mock.calls).toContainEqual(['redacted_at', null]);
    // Technical lens LOW: the LOOKUP is scoped the same way. Without it, a note
    // id from another quote would be read (and its author checked) through this
    // quote — the write would still refuse, but the answer would leak which
    // quote a note belongs to.
    const readEq = (readB.eq as ReturnType<typeof vi.fn>).mock.calls;
    expect(readEq).toContainEqual(['id', ROW.id]);
    expect(readEq).toContainEqual(['quote_id', QUOTE_ID]);
  });

  // A second click must not overwrite the FIRST withdrawal's attribution and
  // timestamp — that one is what actually happened.
  it('reports an already-withdrawn note as such, without restamping it', async () => {
    const { writeB } = twoStep(REDACTED_ROW, null); // the read already shows it withdrawn

    const result = await redactStaffNote({
      quoteId: QUOTE_ID,
      noteId: ROW.id,
      redactedBy: '99999999-9999-4999-8999-999999999999',
      redactedByLabel: 'Someone Else',
      redactedByRole: 'admin',
      reason: null,
    });

    expect(result.kind).toBe('already-redacted');
    if (result.kind !== 'already-redacted') return;
    expect(result.note.redactedByLabel).toBe('Jason'); // the original redactor
    expect(writeB.update).not.toHaveBeenCalled(); // and nothing was rewritten
  });

  it('distinguishes a note that does not exist on this quote from one already withdrawn', async () => {
    twoStep(null, null);

    expect(
      (await redactStaffNote({
        quoteId: QUOTE_ID,
        noteId: ROW.id,
        redactedBy: OPERATOR_ID,
        redactedByLabel: 'Jason',
        redactedByRole: 'admin',
        reason: null,
      })).kind,
    ).toBe('not-found');
  });

  it('refuses at the WRITER, against the row s real author, not anything the caller passed', async () => {
    const { writeB } = twoStep({ ...ROW, created_by: '55555555-5555-4555-8555-555555555555' }, null);

    const result = await redactStaffNote({
      quoteId: QUOTE_ID,
      noteId: ROW.id,
      redactedBy: OPERATOR_ID,
      redactedByLabel: 'Naldo',
      redactedByRole: 'operator',
      reason: null,
    });

    expect(result.kind).toBe('forbidden');
    expect(writeB.update).not.toHaveBeenCalled();
  });

  it('reports an error rather than claiming success when the write fails', async () => {
    const readB = terminalBuilder({ data: ROW, error: null });
    const writeB = terminalBuilder({ data: null, error: { message: 'permission denied' } });
    let call = 0;
    serviceClientRef.current = { from: vi.fn(() => (call++ === 0 ? readB : writeB)) };

    expect(
      (await redactStaffNote({
        quoteId: QUOTE_ID,
        noteId: ROW.id,
        redactedBy: OPERATOR_ID,
        redactedByLabel: 'Jason',
        redactedByRole: 'admin',
        reason: null,
      })).kind,
    ).toBe('error');
  });
});

describe('appendStaffNote', () => {
  it('writes the server-derived author and request id exactly once', async () => {
    const insert = terminalBuilder({ data: ROW, error: null });
    serviceClientRef.current = { from: vi.fn(() => insert) };

    const result = await appendStaffNote({
      quoteId: QUOTE_ID,
      body: ROW.body,
      createdBy: OPERATOR_ID,
      createdByLabel: 'Naldo',
      clientRequestId: REQUEST_ID,
    });

    expect(result).toEqual({
      kind: 'created',
      note: {
        id: ROW.id,
        quoteId: QUOTE_ID,
        body: ROW.body,
        createdBy: OPERATOR_ID,
        createdByLabel: 'Naldo',
        createdAt: ROW.created_at,
        // Row 372: a freshly written note is never withdrawn.
        redactedAt: null,
        redactedByLabel: null,
        redactedReason: null,
      },
    });
    expect(insert.insert).toHaveBeenCalledWith({
      quote_id: QUOTE_ID,
      body: ROW.body,
      created_by: OPERATOR_ID,
      created_by_label: 'Naldo',
      client_request_id: REQUEST_ID,
    });
  });

  it('returns the original note for an identical response-lost retry', async () => {
    const duplicate = terminalBuilder({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const lookup = terminalBuilder({ data: ROW, error: null });
    serviceClientRef.current = {
      from: vi.fn().mockReturnValueOnce(duplicate).mockReturnValueOnce(lookup),
    };

    const result = await appendStaffNote({
      quoteId: QUOTE_ID,
      body: ROW.body,
      createdBy: OPERATOR_ID,
      createdByLabel: 'Naldo',
      clientRequestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ kind: 'duplicate', note: { id: ROW.id } });
    expect(lookup.eq).toHaveBeenNthCalledWith(1, 'quote_id', QUOTE_ID);
    expect(lookup.eq).toHaveBeenNthCalledWith(2, 'client_request_id', REQUEST_ID);
  });

  it('rejects reuse of a request id for different note content', async () => {
    const duplicate = terminalBuilder({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const lookup = terminalBuilder({ data: ROW, error: null });
    serviceClientRef.current = {
      from: vi.fn().mockReturnValueOnce(duplicate).mockReturnValueOnce(lookup),
    };

    await expect(
      appendStaffNote({
        quoteId: QUOTE_ID,
        body: 'Different note',
        createdBy: OPERATOR_ID,
        createdByLabel: 'Naldo',
        clientRequestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ kind: 'conflict' });
  });
});
