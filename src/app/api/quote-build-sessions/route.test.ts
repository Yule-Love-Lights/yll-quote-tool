import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  completeQuoteBuildSession,
  getOwnedQuoteBuildSession,
  getOperator,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
  startQuoteBuildSession,
} = vi.hoisted(() => ({
  completeQuoteBuildSession: vi.fn(),
  getOwnedQuoteBuildSession: vi.fn(),
  getOperator: vi.fn(),
  startQuoteBuildSession: vi.fn(),
  linkQuoteBuildSession: vi.fn(),
  quoteBuildSessionTargetState: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ getOperator }));
vi.mock('@/lib/quoteBuildTiming', () => ({
  completeQuoteBuildSession,
  getOwnedQuoteBuildSession,
  startQuoteBuildSession,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
}));

import { POST } from './route';

const TIMER_ID = '11111111-2222-4333-8444-555555555555';
const QUOTE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function req(body: unknown): Request {
  return new Request('https://quote.example.com/api/quote-build-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperator.mockResolvedValue({ id: 'op-1', name: 'Alex', email: 'alex@example.com', role: 'operator' });
  startQuoteBuildSession.mockResolvedValue({
    ok: true,
    kind: 'started',
    row: { id: TIMER_ID, quote_id: QUOTE_ID, sent_at: null },
  });
  getOwnedQuoteBuildSession.mockResolvedValue({
    id: TIMER_ID,
    quote_id: null,
    sent_at: null,
  });
  linkQuoteBuildSession.mockResolvedValue(true);
  completeQuoteBuildSession.mockResolvedValue(true);
  quoteBuildSessionTargetState.mockResolvedValue({ kind: 'draft' });
});

describe('POST /api/quote-build-sessions', () => {
  it('fails closed for a signed-out or crew account even if the ordinary gate is dormant', async () => {
    getOperator.mockResolvedValueOnce(null);
    const res = await POST(req({ timerId: TIMER_ID, startReason: 'contact_selected' }));
    expect(res.status).toBe(401);
    expect(startQuoteBuildSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ timerId: 'bad', startReason: 'contact_selected' }, 'timerId'],
    [{ timerId: TIMER_ID, startReason: 'other' }, 'startReason'],
    [{ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: 'bad' }, 'quoteId'],
  ])('rejects malformed input %#', async (body, field) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
    expect(startQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('atomically starts a saved draft already linked to that quote', async () => {
    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'prefilled_open', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(200);
    expect(startQuoteBuildSession).toHaveBeenCalledWith({
      timerId: TIMER_ID,
      startReason: 'prefilled_open',
      operator: { id: 'op-1', name: 'Alex', email: 'alex@example.com', role: 'operator' },
      quoteId: QUOTE_ID,
      startedAt: expect.any(String),
    });
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, timerId: TIMER_ID, linked: true });
  });

  it('links an earlier unlinked start when the quote becomes available', async () => {
    startQuoteBuildSession.mockResolvedValueOnce({
      ok: true,
      kind: 'existing',
      row: { id: TIMER_ID, quote_id: null, sent_at: null },
    });

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'prefilled_open', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(200);
    expect(linkQuoteBuildSession).toHaveBeenCalledWith({
      timerId: TIMER_ID,
      quoteId: QUOTE_ID,
      operatorId: 'op-1',
    });
  });

  it('refuses to move an existing timer from one quote to another', async () => {
    startQuoteBuildSession.mockResolvedValueOnce({
      ok: true,
      kind: 'existing',
      row: { id: TIMER_ID, quote_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
    });

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(409);
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('rejects a test, view-only, or non-draft target before starting a timer', async () => {
    quoteBuildSessionTargetState.mockResolvedValueOnce({ kind: 'ineligible' });

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(409);
    expect(startQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('fails closed when target eligibility cannot be verified', async () => {
    quoteBuildSessionTargetState.mockResolvedValueOnce(null);

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(500);
    expect(startQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('completes a timer when Send wins before the draft link finishes', async () => {
    const sentAt = '2026-08-21T12:10:00.000Z';
    quoteBuildSessionTargetState
      .mockResolvedValueOnce({ kind: 'draft' })
      .mockResolvedValueOnce({ kind: 'sent', sentAt });

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(200);
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
    expect(completeQuoteBuildSession).toHaveBeenCalledWith({
      quoteId: QUOTE_ID,
      timerId: TIMER_ID,
      operatorId: 'op-1',
      sentAt,
    });
  });

  it('reconciles an already-started timer when its link arrives after Send', async () => {
    const sentAt = '2026-08-21T12:10:00.000Z';
    quoteBuildSessionTargetState.mockResolvedValueOnce({ kind: 'sent', sentAt });

    const res = await POST(
      req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
    );

    expect(res.status).toBe(200);
    expect(startQuoteBuildSession).not.toHaveBeenCalled();
    expect(getOwnedQuoteBuildSession).toHaveBeenCalledWith({
      timerId: TIMER_ID,
      operatorId: 'op-1',
    });
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
    expect(completeQuoteBuildSession).toHaveBeenCalledWith({
      quoteId: QUOTE_ID,
      timerId: TIMER_ID,
      operatorId: 'op-1',
      sentAt,
    });
  });

  it('creates and completes a missing timer when its request arrived before concurrent Send', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
      const sentAt = '2026-08-21T12:00:01.000Z';
      quoteBuildSessionTargetState.mockResolvedValueOnce({ kind: 'sent', sentAt });
      getOwnedQuoteBuildSession.mockResolvedValueOnce(null);

      const res = await POST(
        req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
      );

      expect(res.status).toBe(200);
      expect(startQuoteBuildSession).toHaveBeenCalledWith({
        timerId: TIMER_ID,
        startReason: 'contact_selected',
        operator: { id: 'op-1', name: 'Alex', email: 'alex@example.com', role: 'operator' },
        quoteId: QUOTE_ID,
        startedAt: '2026-08-21T12:00:00.000Z',
      });
      expect(completeQuoteBuildSession).toHaveBeenCalledWith({
        quoteId: QUOTE_ID,
        timerId: TIMER_ID,
        operatorId: 'op-1',
        sentAt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create an after-the-fact timer for a quote that was already sent', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-21T12:01:00.000Z'));
      quoteBuildSessionTargetState.mockResolvedValueOnce({
        kind: 'sent',
        sentAt: '2026-08-21T12:00:00.000Z',
      });
      getOwnedQuoteBuildSession.mockResolvedValueOnce(null);

      const res = await POST(
        req({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
      );

      expect(res.status).toBe(409);
      expect(startQuoteBuildSession).not.toHaveBeenCalled();
      expect(completeQuoteBuildSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 409 when the id belongs to another staff member', async () => {
    startQuoteBuildSession.mockResolvedValueOnce({ ok: false, kind: 'conflict' });
    const res = await POST(req({ timerId: TIMER_ID, startReason: 'contact_selected' }));
    expect(res.status).toBe(409);
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('returns 500 when timing persistence is unavailable', async () => {
    startQuoteBuildSession.mockResolvedValueOnce({ ok: false, kind: 'failed' });
    const res = await POST(req({ timerId: TIMER_ID, startReason: 'contact_selected' }));
    expect(res.status).toBe(500);
  });
});
