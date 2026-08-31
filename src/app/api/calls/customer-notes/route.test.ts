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

const isSupabaseServiceConfiguredMock = vi.fn();
const getSupabaseServiceClientMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: (...args: unknown[]) => isSupabaseServiceConfiguredMock(...args),
  getSupabaseServiceClient: (...args: unknown[]) => getSupabaseServiceClientMock(...args),
}));

import { GET } from './route';

function req(url: string): Request {
  return new Request(url);
}

// A minimal fake covering exactly the two queries resolveAllContactIds
// makes: the anchor lookup (one quote by highlevel_contact_id) and the
// sibling-quotes lookup (every quote for that customer_id).
function fakeSupabase(opts: {
  anchorCustomerId?: string | null;
  anchorError?: unknown;
  siblingHlIds?: (string | null)[];
  siblingError?: unknown;
}) {
  const from = vi.fn((table: string) => {
    expect(table).toBe('quotes');
    const query = {
      eq: () => query,
      not: () => query,
      limit: () => query,
      maybeSingle: () => {
        if (opts.anchorError) return Promise.resolve({ data: null, error: opts.anchorError });
        return Promise.resolve({
          data: opts.anchorCustomerId !== undefined ? { customer_id: opts.anchorCustomerId } : null,
          error: null,
        });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        if (opts.siblingError) return resolve({ data: null, error: opts.siblingError });
        resolve({
          data: (opts.siblingHlIds ?? []).map((id) => ({ highlevel_contact_id: id })),
          error: null,
        });
      },
    };
    return { select: () => query };
  });
  return { from };
}

beforeEach(() => {
  requireOperatorMock.mockReset().mockResolvedValue(null);
  getCallNotesForCustomerMock.mockReset().mockResolvedValue([]);
  isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
  getSupabaseServiceClientMock.mockReset();
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

  it('resolves every HL contact id the customer\'s quotes carry, not just the one given', async () => {
    // The same gap the admin lens caught on the sibling /customers page:
    // a customer whose quotes carry TWO different HL ids over time must not
    // silently lose the other one's calls here either.
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({ anchorCustomerId: 'cust-1', siblingHlIds: ['contact-1', 'contact-2', null] }),
    );

    await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));

    const passedIds = getCallNotesForCustomerMock.mock.calls[0][0] as string[];
    expect(new Set(passedIds)).toEqual(new Set(['contact-1', 'contact-2']));
  });

  it('falls back to just the given id when no quote/customer can be resolved (a brand-new contact)', async () => {
    getSupabaseServiceClientMock.mockReturnValue(fakeSupabase({ anchorCustomerId: null }));

    await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));

    expect(getCallNotesForCustomerMock).toHaveBeenCalledWith(['contact-1']);
  });

  it('passes the resolved ids through and returns whatever the shared reader returns', async () => {
    getSupabaseServiceClientMock.mockReturnValue(fakeSupabase({ anchorCustomerId: null }));
    getCallNotesForCustomerMock.mockResolvedValueOnce([
      { transcriptId: 't1', calledAt: '2026-08-22T14:00:00.000Z', summary: 'hi', noteStatus: 'posted', tasks: [] },
    ]);

    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));
    const json = await res.json();

    expect(json.calls).toHaveLength(1);
    expect(json.calls[0].transcriptId).toBe('t1');
  });

  it('a genuine backend failure returns a non-200 status, never a 200 that reads as "no calls"', async () => {
    // Before this fix, an outage and a customer with zero calls were
    // indistinguishable to the caller.
    getCallNotesForCustomerMock.mockRejectedValueOnce(new Error('boom'));
    getSupabaseServiceClientMock.mockReturnValue(fakeSupabase({ anchorCustomerId: null }));

    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));

    expect(res.status).not.toBe(200);
    const json = await res.json();
    expect(json.calls).toBeUndefined();
  });

  it('a failure in the id-resolution query itself also surfaces as a non-200, not a silent empty list', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({ anchorError: { message: 'db down' } }),
    );

    const res = await GET(req('http://x/api/calls/customer-notes?hlContactId=contact-1'));

    expect(res.status).not.toBe(200);
    expect(getCallNotesForCustomerMock).not.toHaveBeenCalled();
  });
});
