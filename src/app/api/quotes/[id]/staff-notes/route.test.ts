import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  appendStaffNoteMock,
  getOperatorMock,
  listStaffNotesMock,
  redactStaffNoteMock,
  quoteExistsMock,
  serviceConfiguredRef,
} = vi.hoisted(() => ({
  appendStaffNoteMock: vi.fn(),
  getOperatorMock: vi.fn(),
  listStaffNotesMock: vi.fn(),
  redactStaffNoteMock: vi.fn(),
  quoteExistsMock: vi.fn(),
  serviceConfiguredRef: { current: true },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => serviceConfiguredRef.current,
}));
vi.mock('@/lib/staffNotes', () => ({
  STAFF_NOTE_MAX_LENGTH: 2000,
  STAFF_NOTE_REASON_MAX_LENGTH: 500,
  appendStaffNote: appendStaffNoteMock,
  listStaffNotes: listStaffNotesMock,
  redactStaffNote: redactStaffNoteMock,
  quoteExistsForStaffNotes: quoteExistsMock,
}));

import { GET, PATCH, POST } from './route';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const NOTE = {
  id: '44444444-4444-4444-8444-444444444444',
  quoteId: QUOTE_ID,
  body: 'Gate code is in the lockbox.',
  createdBy: OPERATOR_ID,
  createdByLabel: 'Naldo',
  createdAt: '2026-08-21T14:00:00.000Z',
};

const ctx = (id = QUOTE_ID) => ({ params: Promise.resolve({ id }) });
// Row 373: GET now reads the page cursor off the query string, so the fake
// carries a url. `search` defaults to none — the first page.
const request = (body?: unknown, search = '') =>
  ({
    url: `https://quote.example.com/api/quotes/${QUOTE_ID}/staff-notes${search}`,
    json: async () => {
      if (body === undefined) throw new Error('invalid json');
      return body;
    },
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  serviceConfiguredRef.current = true;
  getOperatorMock.mockResolvedValue({
    id: OPERATOR_ID,
    email: 'naldo@example.com',
    name: 'Naldo',
    role: 'operator',
  });
  quoteExistsMock.mockResolvedValue(true);
  listStaffNotesMock.mockResolvedValue({ notes: [NOTE], hasMore: false });
  redactStaffNoteMock.mockResolvedValue({ kind: 'redacted', note: { ...NOTE, body: '[Note withdrawn]' } });
  appendStaffNoteMock.mockResolvedValue({ kind: 'created', note: NOTE });
});

describe('staff notes authentication', () => {
  it('fails closed without a real operator session', async () => {
    getOperatorMock.mockResolvedValue(null);

    const getResponse = await GET(request({}), ctx());
    const postResponse = await POST(request({ body: 'Private', clientRequestId: REQUEST_ID }), ctx());

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(quoteExistsMock).not.toHaveBeenCalled();
    expect(appendStaffNoteMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/quotes/[id]/staff-notes', () => {
  it('returns the quote-scoped staff timeline', async () => {
    const response = await GET(request({}), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notes: [NOTE], hasMore: false });
    // Row 373: no cursor on the first page.
    expect(listStaffNotesMock).toHaveBeenCalledWith(QUOTE_ID, null);
  });

  // Row 373: the page cursor. Both halves must arrive together — a lone
  // timestamp cannot separate two notes written in the same instant, so a
  // half-cursor is ignored rather than used to skip past a note.
  it('passes a complete page cursor through, and ignores a half one', async () => {
    await GET(request({}, `?beforeCreatedAt=${NOTE.createdAt}&beforeId=${NOTE.id}`), ctx());
    expect(listStaffNotesMock).toHaveBeenLastCalledWith(QUOTE_ID, {
      createdAt: NOTE.createdAt,
      id: NOTE.id,
    });

    // Half a cursor is not a cursor, and is refused rather than quietly
    // serving the first page again.
    expect((await GET(request({}, '?beforeCreatedAt=2026-08-21T14:00:00.000Z'), ctx())).status).toBe(400);
    expect((await GET(request({}, `?beforeId=${NOTE.id}`), ctx())).status).toBe(400);
  });

  // Technical lens MED: listStaffNotes interpolates both halves into a
  // PostgREST `.or()` filter, and postgrest-js escapes nothing. An id that
  // closes the quoting appends a condition of the caller's choosing, so the
  // shape is checked at the boundary rather than trusted downstream.
  it('refuses a cursor that could reshape the database filter', async () => {
    const injections = [
      `${NOTE.id}",body.neq."x`,
      `${NOTE.id}),or(quote_id.neq.`,
      `${NOTE.id},created_at.gt.2000-01-01`,
      "' OR 1=1 --",
    ];
    for (const beforeId of injections) {
      const res = await GET(
        request({}, `?beforeCreatedAt=${encodeURIComponent(NOTE.createdAt)}&beforeId=${encodeURIComponent(beforeId)}`),
        ctx(),
      );
      expect(res.status).toBe(400);
    }

    for (const beforeCreatedAt of ['not-a-date', `${NOTE.createdAt}",id.neq."x`, '2026-08-21']) {
      const res = await GET(
        request({}, `?beforeCreatedAt=${encodeURIComponent(beforeCreatedAt)}&beforeId=${NOTE.id}`),
        ctx(),
      );
      expect(res.status).toBe(400);
    }

    // Nothing reached the database on any of them.
    expect(listStaffNotesMock).not.toHaveBeenCalled();
  });

  it('reports hasMore so the panel can offer the older page', async () => {
    listStaffNotesMock.mockResolvedValueOnce({ notes: [NOTE], hasMore: true });
    const response = await GET(request({}), ctx());
    await expect(response.json()).resolves.toEqual({ notes: [NOTE], hasMore: true });
  });

  it('rejects invalid and missing quote ids', async () => {
    expect((await GET(request({}), ctx('not-a-uuid'))).status).toBe(400);

    quoteExistsMock.mockResolvedValueOnce(false);
    expect((await GET(request({}), ctx())).status).toBe(404);
    expect(listStaffNotesMock).not.toHaveBeenCalled();
  });

  it('returns 503 when service-role access is unavailable', async () => {
    serviceConfiguredRef.current = false;
    expect((await GET(request({}), ctx())).status).toBe(503);
  });
});

describe('POST /api/quotes/[id]/staff-notes', () => {
  it('trims the note and derives its author on the server', async () => {
    const response = await POST(
      request({ body: `  ${NOTE.body}  `, clientRequestId: REQUEST_ID }),
      ctx(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ note: NOTE, duplicate: false });
    expect(appendStaffNoteMock).toHaveBeenCalledWith({
      quoteId: QUOTE_ID,
      body: NOTE.body,
      createdBy: OPERATOR_ID,
      createdByLabel: 'Naldo',
      clientRequestId: REQUEST_ID,
    });
  });

  it.each<{ body: unknown; label: string }>([
    { body: undefined, label: 'malformed json' },
    { body: { body: '', clientRequestId: REQUEST_ID }, label: 'blank body' },
    { body: { body: 'x'.repeat(2001), clientRequestId: REQUEST_ID }, label: 'overlong body' },
    { body: { body: 'Private', clientRequestId: 'not-a-uuid' }, label: 'invalid request id' },
  ])('rejects $label', async ({ body }) => {
    const response = await POST(request(body), ctx());
    expect(response.status).toBe(400);
    expect(appendStaffNoteMock).not.toHaveBeenCalled();
  });

  it('returns the original note without a second append on a retry', async () => {
    appendStaffNoteMock.mockResolvedValueOnce({ kind: 'duplicate', note: NOTE });

    const response = await POST(request({ body: NOTE.body, clientRequestId: REQUEST_ID }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ note: NOTE, duplicate: true });
  });

  it('rejects a request id reused with different content', async () => {
    appendStaffNoteMock.mockResolvedValueOnce({ kind: 'conflict' });
    const response = await POST(request({ body: NOTE.body, clientRequestId: REQUEST_ID }), ctx());
    expect(response.status).toBe(409);
  });

  it('maps quote-deletion races and database failures', async () => {
    appendStaffNoteMock.mockResolvedValueOnce({ kind: 'not-found' });
    expect((await POST(request({ body: NOTE.body, clientRequestId: REQUEST_ID }), ctx())).status).toBe(404);

    appendStaffNoteMock.mockResolvedValueOnce({ kind: 'error' });
    expect((await POST(request({ body: NOTE.body, clientRequestId: REQUEST_ID }), ctx())).status).toBe(500);
  });
});

// ─── Row 372: withdrawing a note ────────────────────────────────────────────
describe('PATCH /api/quotes/[id]/staff-notes — withdraw a note (row 372)', () => {
  it('withdraws under the SERVER-derived operator, never one from the request body', async () => {
    const res = await PATCH(request({ noteId: NOTE.id, reason: 'Wrong customer' }), ctx());

    expect(res.status).toBe(200);
    expect(redactStaffNoteMock).toHaveBeenCalledWith({
      quoteId: QUOTE_ID,
      noteId: NOTE.id,
      redactedBy: OPERATOR_ID,
      redactedByLabel: 'Naldo',
      // Row 372: the ROLE comes from the session too — the author-or-admin
      // rule is decided in the lib against the note's real author, and nothing
      // about the actor is taken from the request body.
      redactedByRole: 'operator',
      reason: 'Wrong customer',
    });
  });

  it('accepts a withdrawal with no reason — the reason can be the sensitive part', async () => {
    await PATCH(request({ noteId: NOTE.id }), ctx());
    expect(redactStaffNoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ reason: null }));

    await PATCH(request({ noteId: NOTE.id, reason: '   ' }), ctx());
    expect(redactStaffNoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ reason: null }));
  });

  it('400s a missing or malformed note id, and never reaches the database', async () => {
    for (const body of [{}, { noteId: 'not-a-uuid' }, { noteId: 42 }]) {
      expect((await PATCH(request(body), ctx())).status).toBe(400);
    }
    expect(redactStaffNoteMock).not.toHaveBeenCalled();
  });

  it('400s a reason that is not text, or is too long', async () => {
    expect((await PATCH(request({ noteId: NOTE.id, reason: 12 }), ctx())).status).toBe(400);
    expect((await PATCH(request({ noteId: NOTE.id, reason: 'x'.repeat(501) }), ctx())).status).toBe(400);
    expect(redactStaffNoteMock).not.toHaveBeenCalled();
  });

  // A second click is not an error — the caller asked for a state the note is
  // already in — and the body carries the ORIGINAL withdrawal so the panel
  // shows who actually did it.
  it('answers 200 for an already-withdrawn note, flagged as such', async () => {
    redactStaffNoteMock.mockResolvedValueOnce({
      kind: 'already-redacted',
      note: { ...NOTE, body: '[Note withdrawn]', redactedByLabel: 'Someone Else' },
    });
    const res = await PATCH(request({ noteId: NOTE.id }), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alreadyRedacted).toBe(true);
    expect(data.note.redactedByLabel).toBe('Someone Else');
  });

  it('404s a note that is not on this quote, and 500s a failed write', async () => {
    redactStaffNoteMock.mockResolvedValueOnce({ kind: 'not-found' });
    expect((await PATCH(request({ noteId: NOTE.id }), ctx())).status).toBe(404);

    redactStaffNoteMock.mockResolvedValueOnce({ kind: 'error' });
    expect((await PATCH(request({ noteId: NOTE.id }), ctx())).status).toBe(500);
  });

  it('403s when the lib refuses the actor, with copy that says who may', async () => {
    redactStaffNoteMock.mockResolvedValueOnce({ kind: 'forbidden' });
    const res = await PATCH(request({ noteId: NOTE.id }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('wrote a note');
  });

  it('fails closed without an operator session', async () => {
    getOperatorMock.mockResolvedValue(null);
    expect((await PATCH(request({ noteId: NOTE.id }), ctx())).status).toBe(401);
    expect(redactStaffNoteMock).not.toHaveBeenCalled();
  });
});
