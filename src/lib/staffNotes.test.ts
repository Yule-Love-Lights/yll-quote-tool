import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serviceClientRef } = vi.hoisted(() => ({
  serviceClientRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => serviceClientRef.current,
}));

import {
  STAFF_NOTES_PAGE_SIZE,
  appendStaffNote,
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
