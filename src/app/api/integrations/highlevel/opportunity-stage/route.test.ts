// Route tests for the HighLevel opportunity-stage webhook (S75).
//
// The rule this suite exists to pin, in Naldo's words: an approved quote can
// never be archived from here. Everything else (auth, payload tolerance,
// idempotency, the TOCTOU re-check) hangs off that.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, notifyMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  notifyMock: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/integrations/telegramRouting', () => ({ notifyTelegramAudience: notifyMock }));

import { POST } from './route';
import { NEIGHBORS_DECLINED_STAGE_ID } from '@/lib/integrations/ghlPipelineMap';

const SECRET = 'test-webhook-secret';

// The Christmas Lights Declined stage, from ghlPipelineMap.
const HOLIDAY_DECLINED = '92090ef4-b8d6-4d68-b0f6-b4462e60d658';
const HOLIDAY_BID_SENT = 'd15bc673-2b97-48a6-8a5c-bdf3b6e4d076';

type Quote = Record<string, unknown>;

/**
 * Minimal Supabase fake for this route's two chains.
 *   read:  from('quotes').select(cols).eq(col, val).returns()   → { data, error }
 *   write: from('quotes').update(p).eq().eq().is().is().select('id') → { data, error }
 * `writeMatches` simulates whether the write's own guards still hold at write
 * time, which is how the TOCTOU test makes a read-then-approve race reachable.
 */
function makeSb(quotes: Quote[], opts: { writeMatches?: boolean; readError?: string } = {}) {
  const writeMatches = opts.writeMatches ?? true;
  const updates: Record<string, unknown>[] = [];
  const sb = {
    updates,
    from() {
      const readChain: Record<string, unknown> = {
        select: () => readChain,
        eq: () => readChain,
        returns: () => readChain,
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            opts.readError
              ? { data: null, error: { message: opts.readError } }
              : { data: quotes, error: null },
          ),
      };
      const writeChain: Record<string, unknown> = {
        eq: () => writeChain,
        is: () => writeChain,
        select: () => writeChain,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: writeMatches ? [{ id: 'claimed' }] : [], error: null }),
      };
      return {
        ...readChain,
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          return writeChain;
        },
      };
    },
  };
  return sb;
}

function req(body: unknown, secret: string | null = SECRET): NextRequest {
  return {
    headers: { get: (k: string) => (k === 'x-dashboard-secret' ? secret : null) },
    json: async () => {
      if (body === '__invalid__') throw new Error('bad json');
      return body;
    },
  } as unknown as NextRequest;
}

const liveQuote = (over: Quote = {}): Quote => ({
  id: 'q-1',
  quote_number: 1301,
  customer_name: 'Stephen Siena',
  status: 'sent',
  quote_sent_at: '2026-08-01T00:00:00Z',
  viewed_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  view_only: false,
  approval_snapshot: null,
  ...over,
});

beforeEach(() => {
  process.env.DASHBOARD_WEBHOOK_SECRET = SECRET;
  notifyMock.mockClear();
});

describe('auth and payload handling', () => {
  it('401s without the shared secret', async () => {
    sbRef.current = makeSb([liveQuote()]);
    const res = await POST(req({ contactId: 'c1', outcome: 'declined' }, null));
    expect(res.status).toBe(401);
  });

  it('401s on a wrong secret', async () => {
    sbRef.current = makeSb([liveQuote()]);
    const res = await POST(req({ contactId: 'c1', outcome: 'declined' }, 'nope'));
    expect(res.status).toBe(401);
  });

  it('400s on an unparseable body', async () => {
    sbRef.current = makeSb([]);
    const res = await POST(req('__invalid__'));
    expect(res.status).toBe(400);
  });

  it('400s when no contact id can be found in any spelling', async () => {
    sbRef.current = makeSb([]);
    const res = await POST(req({ outcome: 'declined' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no-contact');
  });

  it('accepts the contact id under each spelling a GHL workflow might send', async () => {
    for (const body of [
      { contactId: 'c1', outcome: 'declined' },
      { contact_id: 'c1', outcome: 'declined' },
      { id: 'c1', outcome: 'declined' },
      { contact: { id: 'c1' }, outcome: 'declined' },
    ]) {
      sbRef.current = makeSb([liveQuote()]);
      const res = await POST(req(body));
      expect(res.status).toBe(200);
      expect((await res.json()).archived).toBe(1);
    }
  });

  it('maps a raw pipeline stage id when no explicit outcome is given', async () => {
    sbRef.current = makeSb([liveQuote()]);
    const res = await POST(req({ contactId: 'c1', pipelineStageId: HOLIDAY_DECLINED }));
    const json = await res.json();
    expect(json.outcome).toBe('declined');
    expect(json.archived).toBe(1);
  });

  it('reads a nested opportunity stage id too', async () => {
    sbRef.current = makeSb([liveQuote()]);
    const res = await POST(req({ contactId: 'c1', opportunity: { pipeline_stage_id: HOLIDAY_DECLINED } }));
    expect((await res.json()).archived).toBe(1);
  });

  it('ignores an ordinary pipeline move with a 200, so HighLevel does not retry it', async () => {
    const sb = makeSb([liveQuote()]);
    sbRef.current = sb;
    const res = await POST(req({ contactId: 'c1', pipelineStageId: HOLIDAY_BID_SENT }));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe('not-an-archive-stage');
    expect(sb.updates).toHaveLength(0);
  });

  it('treats the Neighbors declined stage as a decline', async () => {
    sbRef.current = makeSb([liveQuote()]);
    const res = await POST(req({ contactId: 'c1', pipelineStageId: NEIGHBORS_DECLINED_STAGE_ID }));
    expect((await res.json()).outcome).toBe('declined');
  });
});

describe('the money guard', () => {
  it('refuses an approved quote and writes nothing', async () => {
    const sb = makeSb([liveQuote({ status: 'approved', customer_approved_at: '2026-08-02T00:00:00Z' })]);
    sbRef.current = sb;
    const res = await POST(req({ contactId: 'c1', outcome: 'declined' }));
    const json = await res.json();
    expect(json.archived).toBe(0);
    expect(json.refused).toHaveLength(1);
    expect(json.refused[0].reason).toBe('has-money');
    expect(sb.updates).toHaveLength(0);
  });

  it('refuses a paid quote and writes nothing', async () => {
    const sb = makeSb([
      liveQuote({
        status: 'booked',
        customer_approved_at: '2026-08-02T00:00:00Z',
        deposit_paid_at: '2026-08-03T00:00:00Z',
      }),
    ]);
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'abandoned' }))).json();
    expect(json.refused[0].reason).toBe('has-money');
    expect(sb.updates).toHaveLength(0);
  });

  it('pings staff when a quote with money on it was left alone', async () => {
    sbRef.current = makeSb([liveQuote({ status: 'approved', customer_approved_at: '2026-08-02T00:00:00Z' })]);
    await POST(req({ contactId: 'c1', outcome: 'declined' }));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const text = String((notifyMock.mock.calls[0] as unknown as unknown[])[1]);
    expect(text).toContain('Stephen Siena');
    expect(text).toContain('1301');
  });

  it('stays quiet when nothing was refused', async () => {
    sbRef.current = makeSb([liveQuote()]);
    await POST(req({ contactId: 'c1', outcome: 'declined' }));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('refuses when the approval lands between the read and the write', async () => {
    // The row read as live, the guarded write matched zero rows: the deposit or
    // approval landed in the gap. This must report, never retry into it.
    const sb = makeSb([liveQuote()], { writeMatches: false });
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'declined' }))).json();
    expect(json.archived).toBe(0);
    expect(json.refused[0].reason).toBe('lost-race');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe('the archive write', () => {
  it('sets the terminal status and records what did it', async () => {
    const sb = makeSb([liveQuote()]);
    sbRef.current = sb;
    await POST(req({ contactId: 'c1', outcome: 'declined' }));
    expect(sb.updates).toHaveLength(1);
    const payload = sb.updates[0] as { status: string; approval_snapshot: Record<string, unknown> };
    expect(payload.status).toBe('declined');
    const marker = payload.approval_snapshot.ghlArchived as Record<string, unknown>;
    expect(marker.outcome).toBe('declined');
    expect(marker.contactId).toBe('c1');
    expect(marker.priorStatus).toBe('sent');
    expect(marker.source).toBe('ghl-opportunity-stage-webhook');
  });

  // Premerge customer lens (HIGH, fixed here): the first cut also set
  // view_only. StickyBottomBar checks view_only BEFORE isTerminalBrowseStatus,
  // so that combination showed an archived customer the unrelated "Just
  // browsing" copy and made the reopen-ask button unreachable. The terminal
  // status alone is what closes the quote; this pins that it stays that way.
  it('never writes view_only, so the portal shows the reopen ask and not the browsing strip', async () => {
    const sb = makeSb([liveQuote()]);
    sbRef.current = sb;
    await POST(req({ contactId: 'c1', outcome: 'abandoned' }));
    expect(sb.updates[0]).not.toHaveProperty('view_only');
    expect(Object.keys(sb.updates[0]).sort()).toEqual(['approval_snapshot', 'status']);
  });

  it('preserves an existing approval snapshot instead of replacing it', async () => {
    const sb = makeSb([liveQuote({ approval_snapshot: { customerSelection: { keep: true } } })]);
    sbRef.current = sb;
    await POST(req({ contactId: 'c1', outcome: 'abandoned' }));
    const payload = sb.updates[0] as { approval_snapshot: Record<string, unknown> };
    expect(payload.approval_snapshot.customerSelection).toEqual({ keep: true });
    expect(payload.approval_snapshot.ghlArchived).toBeDefined();
  });

  it('is idempotent: a repeat webhook for the same drag writes nothing', async () => {
    const sb = makeSb([liveQuote({ status: 'declined' })]);
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'declined' }))).json();
    expect(sb.updates).toHaveLength(0);
    expect(json.skipped[0].reason).toBe('already-terminal');
  });

  it('leaves a staff-parked view-only quote alone', async () => {
    const sb = makeSb([liveQuote({ view_only: true })]);
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'declined' }))).json();
    expect(sb.updates).toHaveLength(0);
    expect(json.skipped[0].reason).toBe('already-view-only');
  });

  it('handles every quote linked to the contact, archiving only the eligible ones', async () => {
    const sb = makeSb([
      liveQuote({ id: 'q-live', status: 'sent' }),
      liveQuote({ id: 'q-paid', status: 'booked', deposit_paid_at: '2026-08-03T00:00:00Z' }),
      liveQuote({ id: 'q-done', status: 'declined' }),
    ]);
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'declined' }))).json();
    expect(json.matched).toBe(3);
    expect(json.archived).toBe(1);
    expect(json.refused).toHaveLength(1);
    expect(json.skipped).toHaveLength(1);
    expect(sb.updates).toHaveLength(1);
  });

  it('reports a contact with no quotes without touching anything', async () => {
    const sb = makeSb([]);
    sbRef.current = sb;
    const json = await (await POST(req({ contactId: 'c1', outcome: 'declined' }))).json();
    expect(json.matched).toBe(0);
    expect(sb.updates).toHaveLength(0);
  });

  it('500s on a lookup failure rather than reporting a silent success', async () => {
    sbRef.current = makeSb([], { readError: 'boom' });
    const res = await POST(req({ contactId: 'c1', outcome: 'declined' }));
    expect(res.status).toBe(500);
  });
});
