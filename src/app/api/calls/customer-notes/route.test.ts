// Coverage for GET /api/calls/customer-notes?hlContactId=... — the client-
// side data source for the quote builder's call-notes drawer (Naldo's ask,
// 2026-08-31). Same content as the /customers/[contactId] server-rendered
// panel, reached over an API because QuoteBuilder is a client component.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOperatorMock = vi.fn();
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: (...args: unknown[]) => requireOperatorMock(...args) }));

const getCallNotesForCustomerMock = vi.fn();
vi.mock('@/lib/calls/customerCallNotes', () => ({
  getCallNotesForCustomer: (...args: unknown[]) => getCallNotesForCustomerMock(...args),
}));

import { GET } from './route';

function req(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  requireOperatorMock.mockReset().mockResolvedValue(null);
  getCallNotesForCustomerMock.mockReset().mockResolvedValue([]);
});

describe('GET /api/calls/customer-notes', () => {
  it('returns the denial response unchanged when the caller is not an operator', async () => {
    const denial = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);

    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=c1'));

    expect(res).toBe(denial);
    expect(getCallNotesForCustomerMock).not.toHaveBeenCalled();
  });

  it('returns an empty list without querying when hlContactId is missing', async () => {
    const res = await GET(req('http://x/api/calls/customer-notes'));
    const json = await res.json();
    expect(json).toEqual({ calls: [] });
    expect(getCallNotesForCustomerMock).not.toHaveBeenCalled();
  });

  it('passes the id through and returns whatever the shared reader returns', async () => {
    getCallNotesForCustomerMock.mockResolvedValueOnce([
      { transcriptId: 't1', calledAt: '2026-08-22T14:00:00.000Z', summary: 'hi', noteStatus: 'posted', tasks: [] },
    ]);

    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));
    const json = await res.json();

    expect(getCallNotesForCustomerMock).toHaveBeenCalledWith(['contact-1']);
    expect(json.calls).toHaveLength(1);
    expect(json.calls[0].transcriptId).toBe('t1');
  });

  it('degrades to an empty list rather than a 500 when the reader itself fails (the shared function already swallows schema-missing errors; this is the outer safety net)', async () => {
    getCallNotesForCustomerMock.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: [] });
  });
});
