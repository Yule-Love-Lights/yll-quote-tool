// Row 367 — the design's post-approval freeze predicate. Kept as its own unit
// table because the whole point of extracting it is that /api/designs/[id],
// /api/quote and QuoteBuilder read ONE rule; a change here is a change to all
// three, and should have to break a named case to happen.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { isSceneFrozen, readSceneLock, refuseIfFrozen, SCENE_LOCKED_CODE, type SceneFreezeRow } from './sceneFreeze';

const base: SceneFreezeRow = {
  quote_sent_at: '2026-08-01T00:00:00Z',
  viewed_at: '2026-08-01T01:00:00Z',
  customer_approved_at: null,
  deposit_paid_at: null,
  status: 'sent',
  is_test: false,
};

const approved: SceneFreezeRow = { ...base, status: 'approved', customer_approved_at: '2026-08-02T00:00:00Z' };

describe('isSceneFrozen', () => {
  it('is false before any approval — draft, sent, viewed, changes_requested', () => {
    for (const status of ['draft', 'sent', 'viewed', 'changes_requested'] as const) {
      expect(isSceneFrozen({ ...base, status })).toBe(false);
    }
  });

  it('is TRUE once the customer approved and the order is not booked', () => {
    expect(isSceneFrozen(approved)).toBe(true);
  });

  it('is false for a BOOKED order — the amend flow is the sanctioned way to change it', () => {
    expect(isSceneFrozen({ ...approved, deposit_paid_at: '2026-08-03T00:00:00Z' })).toBe(false);
  });

  it('stays TRUE for a terminal status reached AFTER an approval', () => {
    // deriveStatus reports the persisted terminal status, never 'booked', so a
    // quote declined/cancelled/abandoned post-approval is still frozen. Its
    // recovery path is the same one the money freeze names: revive (re-send),
    // which clears customer_approved_at and unfreezes both at once.
    for (const status of ['declined', 'cancelled', 'abandoned'] as const) {
      expect(isSceneFrozen({ ...approved, status })).toBe(true);
    }
  });

  it('is false for an is_test quote regardless of lifecycle stamps', () => {
    expect(isSceneFrozen({ ...approved, is_test: true })).toBe(false);
    expect(isSceneFrozen({ ...approved, status: 'cancelled', is_test: true })).toBe(false);
  });

  it('treats a missing is_test column as NOT a test quote', () => {
    // A caller that forgets the column must fail SAFE (frozen), never open.
    const withoutFlag: SceneFreezeRow = { ...approved };
    delete withoutFlag.is_test;
    expect(isSceneFrozen(withoutFlag)).toBe(true);
  });

  it('exports the wire code the editor branches on', () => {
    expect(SCENE_LOCKED_CODE).toBe('design-locked');
  });
});

// ── readSceneLock: the lookup every scene writer now goes through ────────────
// Two queries: designs.quote_id, then the quote's lifecycle columns. The
// interesting behaviour is what it does when it CANNOT answer — see the
// `ok: false` cases, which callers turn into a retryable 5xx rather than
// guessing in either direction.
function fakeSb(opts: {
  quoteId?: string | null;
  quote?: Record<string, unknown> | null;
  designError?: string;
  quoteError?: string;
}) {
  const selected: Record<string, string> = {};
  function from(table: string) {
    const b = {
      select(cols: string) {
        selected[table] = cols;
        return b;
      },
      eq: () => b,
      async maybeSingle() {
        if (table === 'designs') {
          if (opts.designError) return { data: null, error: { message: opts.designError } };
          return { data: { quote_id: opts.quoteId ?? null }, error: null };
        }
        if (opts.quoteError) return { data: null, error: { message: opts.quoteError } };
        return { data: opts.quote ?? null, error: null };
      },
    };
    return b;
  }
  return { client: { from }, selected };
}

const APPROVED = {
  status: 'approved',
  quote_sent_at: '2026-08-01T00:00:00Z',
  viewed_at: '2026-08-01T01:00:00Z',
  customer_approved_at: '2026-08-02T00:00:00Z',
  deposit_paid_at: null,
  is_test: false,
};

describe('readSceneLock', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('locks a design whose linked quote is approved and not booked', async () => {
    sbRef.current = fakeSb({ quoteId: 'q1', quote: APPROVED }).client;
    expect(await readSceneLock('d1')).toEqual({ ok: true, locked: true, quoteId: 'q1', auditable: true });
  });

  it('does not lock a booked order — the amend path stays open', async () => {
    sbRef.current = fakeSb({
      quoteId: 'q1',
      quote: { ...APPROVED, deposit_paid_at: '2026-08-03T00:00:00Z' },
    }).client;
    // Row 423: a booked order is the one state where a design write still
    // LANDS on a signed-off quote, so it is also the one that must be audited.
    expect(await readSceneLock('d1')).toEqual({ ok: true, locked: false, quoteId: 'q1', auditable: true });
  });

  it('does not lock an UNLINKED design, or one whose quote row is gone', async () => {
    // Nothing was ever signed off, so there is no agreement to protect.
    // Nothing signed off, so nothing to protect AND nothing to audit onto.
    sbRef.current = fakeSb({ quoteId: null }).client;
    expect(await readSceneLock('d1')).toEqual({ ok: true, locked: false, quoteId: null, auditable: false });
    sbRef.current = fakeSb({ quoteId: 'q1', quote: null }).client;
    expect(await readSceneLock('d1')).toEqual({ ok: true, locked: false, quoteId: null, auditable: false });
  });

  it('reports ok:false — never a lock, never a licence — when a read fails', async () => {
    sbRef.current = fakeSb({ designError: 'boom' }).client;
    expect(await readSceneLock('d1')).toEqual({ ok: false });
    sbRef.current = fakeSb({ quoteId: 'q1', quoteError: 'boom' }).client;
    expect(await readSceneLock('d1')).toEqual({ ok: false });
  });

  it('reports ok:false when there is no service client at all', async () => {
    sbRef.current = null;
    expect(await readSceneLock('d1')).toEqual({ ok: false });
  });

  it('selects every column the predicate reads', async () => {
    // Technical-lens LOW on the first cut: the route test's fake ignored
    // .select() arguments, so a wrong column list would have gone unnoticed —
    // and a column the predicate reads but the query omits arrives as
    // undefined, which for is_test would fail SAFE but for
    // customer_approved_at would fail OPEN. Assert the list explicitly.
    const fake = fakeSb({ quoteId: 'q1', quote: APPROVED });
    sbRef.current = fake.client;
    await readSceneLock('d1');
    for (const col of ['status', 'quote_sent_at', 'viewed_at', 'customer_approved_at', 'deposit_paid_at', 'is_test']) {
      expect(fake.selected.quotes).toContain(col);
    }
    expect(fake.selected.designs).toContain('quote_id');
  });
});

describe('readSceneLock — the row 423 audit signal', () => {
  it('is false for a quote that was never approved, however far along it is', async () => {
    sbRef.current = fakeSb({
      quoteId: 'q1',
      quote: { ...APPROVED, status: 'viewed', customer_approved_at: null },
    }).client;
    const lock = await readSceneLock('d1');
    expect(lock).toMatchObject({ ok: true, locked: false, auditable: false });
  });

  it('is false for an is_test quote even once approved', async () => {
    // Parity with the freeze itself: a test quote is exempt from both.
    sbRef.current = fakeSb({ quoteId: 'q1', quote: { ...APPROVED, is_test: true } }).client;
    expect(await readSceneLock('d1')).toMatchObject({ locked: false, auditable: false });
  });
});

// ── Row 427: ONE refusal, shared by every design write route ─────────────────
// Row 367 gated the scene; four premerge lenses hunting the same class on a
// later PR found the base photo, extra photos, the satellite image and the
// satellite trace still open, each a separate route with its own check or none.
// This helper is the answer, so it is the thing that must be right.
describe('refuseIfFrozen', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('returns null — carry on — for a design nothing has approved', async () => {
    sbRef.current = fakeSb({ quoteId: 'q1', quote: { ...APPROVED, customer_approved_at: null } }).client;
    expect(await refuseIfFrozen('d1')).toBeNull();
  });

  it('returns a 409 carrying the shared code when frozen', async () => {
    sbRef.current = fakeSb({ quoteId: 'q1', quote: APPROVED }).client;
    const res = await refuseIfFrozen('d1');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.code).toBe(SCENE_LOCKED_CODE);
  });

  it('returns a retryable 500 with NO lock code when the state cannot be read', async () => {
    // Every route that uses this inherits the rule: a transient blip must not
    // manufacture a permanent refusal, and must not wave the write through.
    sbRef.current = fakeSb({ designError: 'boom' }).client;
    const res = await refuseIfFrozen('d1');
    expect(res!.status).toBe(500);
    expect((await res!.json()).code).toBeUndefined();
  });
});
