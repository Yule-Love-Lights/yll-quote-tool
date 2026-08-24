import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serviceClientRef } = vi.hoisted(() => ({
  serviceClientRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => serviceClientRef.current,
}));

import {
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

    await expect(listStaffNotes(QUOTE_ID)).resolves.toEqual([
      {
        id: ROW.id,
        quoteId: QUOTE_ID,
        body: ROW.body,
        createdBy: OPERATOR_ID,
        createdByLabel: 'Naldo',
        createdAt: ROW.created_at,
      },
    ]);
    expect(query.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
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
