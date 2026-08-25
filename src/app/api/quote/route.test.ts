// Tests for POST /api/quote input validation (audit fix quote-route-validation).
// Proves: (1) a non-UUID quoteId routes to insert (saveQuote) not update; a real
// UUID routes to update. (2) an over-cap array (>500) is a 400. (3) a malformed
// typed element (e.g. a wreath with a bad size) is a clean 400, not a 500.
// The data layer (saveQuote/updateQuote) + designs are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  completeQuoteBuildSession,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
  save,
  startQuoteBuildSession,
  update,
  getRaw,
  rawRef,
  operatorRef,
} = vi.hoisted(() => ({
  completeQuoteBuildSession: vi.fn(),
  linkQuoteBuildSession: vi.fn(),
  quoteBuildSessionTargetState: vi.fn(),
  startQuoteBuildSession: vi.fn(),
  // Typed varargs so `.mock.calls[n]` is an indexable unknown[] (the permanent
  // dispatch tests read positional args like calls[0][3] = serviceType).
  save: vi.fn(async (..._args: unknown[]) => ({ id: 'new-id' })),
  // FIX D (#237 fix round 2): return type widened (still defaults to the
  // plain { id } shape) so individual tests can override with
  // mockResolvedValueOnce to simulate updateQuote's late-read priorInputs —
  // see the TOCTOU tests below.
  update: vi.fn(
    async (
      ..._args: unknown[]
    ): Promise<{
      id: string;
      priorInputs?: { event?: { eventDate?: string } } | null;
      identityFrozen?: boolean;
    }> => ({ id: 'existing-id' }),
  ),
  // getQuoteRaw is consulted only on the update branch (W1-003 booked-re-price
  // gate). rawRef.current is the row the mock returns; null = row not found,
  // undefined default = a plain draft (no lifecycle timestamps → not booked).
  getRaw: vi.fn(async () => rawRef.current),
  rawRef: {
    current: null as {
      quote_sent_at: string | null;
      customer_approved_at: string | null;
      deposit_paid_at: string | null;
      viewed_at?: string | null;
      status?: string | null;
      service_type?: string | null;
      result?: {
        permanentRatesSnapshot?: unknown;
        eventRatesSnapshot?: unknown;
        permanentBistroRatesSnapshot?: unknown;
      } | null;
      // #177 fix 3b: the stored depositPercent, read back to compare against an
      // incoming change on an already-approved quote.
      // FIX B (#237 fix round): event.eventDate — the stored PRIOR value the
      // re-push gate compares the incoming save against.
      // Row 331+341: the stored line-price/label overrides + bistro run
      // footage, read back the same way for the post-approval freeze tests.
      inputs?: {
        depositPercent?: number;
        event?: { eventDate?: string };
        lineItemPriceOverrides?: Record<string, { amount: number; reason?: string }>;
        labelOverrides?: Record<string, string>;
        permanentBistro?: { poles?: number; bistro?: { id?: string; footage: number }[] };
      } | null;
      // FIX B (#237 fix round): the two other gates the re-push needs.
      is_test?: boolean;
      view_only?: boolean;
      highlevel_contact_id?: string | null;
      // Row 344 Part B: the stored total + frozen approval snapshot, read
      // back to detect + record a post-approval reprice.
      total?: number | null;
      approval_snapshot?: {
        customerSelection?: { currentTotalUsd?: number };
        postApprovalReprices?: unknown[];
        // MED fix round: a booked-and-amended quote's accepted amendment
        // trail, read by resolveAgreedTotal + the hasAcceptedAmendment
        // check (mirrors the real AmendmentTrailEntry/consent shape).
        amendments?: Array<{
          new_total: number;
          delta: number;
          consent?: { status?: string | null } | null;
        }>;
        pricing?: unknown;
      } | null;
    } | null,
  },
  operatorRef: { current: null as { id: string; email: string | null; role: string } | null },
}));

vi.mock('@/lib/quotes', () => ({
  saveQuote: save,
  updateQuote: update,
  getQuoteRaw: getRaw,
}));

vi.mock('@/lib/quoteBuildTiming', () => ({
  completeQuoteBuildSession,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
  startQuoteBuildSession,
}));

// FIX B (#237 fix round): only pushEventDateToGhl is mocked (spied on) — the
// real formatEventDateForGhl runs (importOriginal), the same real function
// the route uses for its own change-comparison, so a test can't accidentally
// pass by comparing against a fake.
const { pushEventDateMock } = vi.hoisted(() => ({
  pushEventDateMock: vi.fn(async (_contactId: string, _eventDate: string | null | undefined) => ({ pushed: true })),
}));
vi.mock('@/lib/integrations/ghlEventDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integrations/ghlEventDate')>()),
  pushEventDateToGhl: pushEventDateMock,
}));

// FIX A (#237 fix round 2): route.ts now schedules the re-push via
// next/server's after() instead of a bare `void` call (see the route's own
// FIX A comment) — the real after() throws outside a request scope, which
// this plain vitest environment never establishes, so it must be mocked.
// Fires the task immediately without awaiting it (same non-blocking timing
// the old void call had, per referrals.test.ts's identical precedent — see
// its "Review fix 8" comment) so every existing pushEventDateMock assertion
// below keeps working unmodified; afterCallCount lets ONE test additionally
// assert the call was actually routed through after(), not just that the
// push still fires (a bare void call would make these tests pass too).
// #314 fix round: lastAfterTask captures the SAME task's promise (still fired
// immediately/undrained, so every existing pushEventDateMock assertion below
// keeps working unmodified) so a test that cares about the stamp write
// (which chains an extra couple of awaits past pushEventDateToGhl itself)
// can explicitly `await lastAfterTask.current` before asserting on it.
const { afterCallCount, lastAfterTask } = vi.hoisted(() => ({
  afterCallCount: { current: 0 },
  lastAfterTask: { current: null as Promise<void> | null },
}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: () => Promise<void> | void) => {
      afterCallCount.current++;
      lastAfterTask.current = Promise.resolve(task());
    },
  };
});

// #314 fix round (staff-lens HIGH): a confirmed push now stamps
// quotes.ghl_event_date_pushed via a fresh getSupabaseServiceClient() call
// inside the after() task — mocked here the same way approve/send route
// tests mock the data layer, capturing update payloads.
//
// Row 344 fix round (technical/admin-lens HIGH): the post-approval-reprice
// audit write now re-fetches approval_snapshot fresh and CASes on it (see
// route.ts's row-344 comment), mirroring apply-color-request.ts's own CAS
// idiom. The chain is now `.select('approval_snapshot').eq('id',
// ...).maybeSingle()` for the re-fetch, and
// `.update(...).eq('id', ...).eq('approval_snapshot', json).select('id')`
// for the conditional write — so the mock builder needs to be a generic
// chainable/thenable, not the single-`.eq()`-then-object the old GHL-only
// shape supported. `freshApprovalSnapshotRef` lets a test simulate a
// concurrent writer landing between the route's read and its write (default
// undefined = "nothing concurrent", which makes the re-fetch return null and
// the route fall back to `existing.approval_snapshot` — i.e. every
// pre-existing assertion below keeps working unmodified). `casResultRef`
// controls whether the conditional update behaves as having WON or LOST
// that race (default 'win' = updatedRows non-empty).
const { sbUpdatePayloads, freshApprovalSnapshotRef, casResultRef } = vi.hoisted(() => ({
  sbUpdatePayloads: [] as Array<Record<string, unknown>>,
  freshApprovalSnapshotRef: { current: undefined as Record<string, unknown> | undefined },
  casResultRef: { current: 'win' as 'win' | 'lose' },
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: () => {
      let isUpdate = false;
      let hasSelect = false;
      const builder: {
        select: (cols: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        update: (payload: Record<string, unknown>) => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: (resolve: (v: { data: unknown; error: null }) => void) => void;
      } = {
        select: (_cols: string) => {
          hasSelect = true;
          return builder;
        },
        eq: (_col: string, _val: unknown) => builder,
        update: (payload: Record<string, unknown>) => {
          isUpdate = true;
          sbUpdatePayloads.push(payload);
          return builder;
        },
        maybeSingle: async () => ({
          data:
            freshApprovalSnapshotRef.current !== undefined
              ? { approval_snapshot: freshApprovalSnapshotRef.current }
              : null,
          error: null,
        }),
        // Only the write chains (update().eq()...select()) ever resolve via
        // `await builder` directly (no terminal .maybeSingle()) — the plain
        // GHL-stamp update (no .select()) resolves { error: null } same as
        // before; the row-344 CAS write (has .select('id')) resolves a rows
        // array so the route can detect a lost race.
        then: (resolve) => {
          if (isUpdate && hasSelect) {
            resolve({ data: casResultRef.current === 'win' ? [{ id: 'x' }] : [], error: null });
          } else {
            resolve({ data: null, error: null });
          }
        },
      };
      return builder;
    },
  }),
}));

// No design linked in most tests → isValidDesignId false, getDesign untouched.
// W1-010: designIdRef.current flips this per-test so the design-projection
// money branch (route.ts ~398: getDesign → applyProjectionToInputs) gets real
// route-level coverage instead of always being skipped.
const { designIdRef, getDesignMock } = vi.hoisted(() => ({
  designIdRef: { current: false },
  getDesignMock: vi.fn(async (_id: string) => null as unknown),
}));
vi.mock('@/lib/designs', () => ({
  isValidDesignId: () => designIdRef.current,
  getDesign: getDesignMock,
}));

// Auth: gate allows (requireOperator → null); getOperator returns whatever the
// test sets, so we can assert the actor id is threaded to saveQuote as created_by.
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
  getOperator: async () => operatorRef.current,
}));

// Permanent pricing reads live rates from app_settings on a NEW quote; mock so
// the permanent path never touches Supabase. Front $40 / sides+back $35.
vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => ({
    permanentRates: { frontPerFt: 40, sidesPerFt: 35, backPerFt: 35, minimumJobAmount: 2500, maintenancePrice: 0 },
    // Distinct event rates (roofline easy = $5) so a test can prove the route
    // reads settings.eventRates, not the engine's compiled default (easy = $7).
    eventRates: {
      roofline: { easy: 5, medium: 5, hard: 5 },
      mini: { canopy: 20, trunk: 20 },
      spritzer: { '16': 40, '24': 40, '32': 40 },
      bistroPerFt: 8,
      barrelBoxPrice: 100,
    },
    // Distinct permanent-bistro rates (perFt $6) so a test can prove the route
    // reads settings.permanentBistroRates, not the engine's compiled default
    // (perFt $30).
    permanentBistroRates: { perFt: 6, perPole: 20, minimum: 0 },
  }),
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

// A minimal but fully-valid inputs object that prices cleanly.
function validInputs(): Record<string, unknown> {
  return {
    santasFootage: 0,
    gingerbreadFootage: 0,
    winterWonderlandFootage: 0,
    stakeLightingFootage: 0,
    santasDifficulty: 'easy',
    gingerbreadDifficulty: 'easy',
    winterWonderlandDifficulty: 'easy',
    stakeLightingDifficulty: 'easy',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
  };
}

const REAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  operatorRef.current = null;
  designIdRef.current = false;
  afterCallCount.current = 0;
  lastAfterTask.current = null;
  sbUpdatePayloads.length = 0;
  freshApprovalSnapshotRef.current = undefined;
  casResultRef.current = 'win';
  getDesignMock.mockResolvedValue(null);
  completeQuoteBuildSession.mockResolvedValue(true);
  linkQuoteBuildSession.mockResolvedValue(true);
  quoteBuildSessionTargetState.mockResolvedValue({ kind: 'draft' });
  startQuoteBuildSession.mockImplementation(async (input: { timerId: string; quoteId?: string }) => ({
    ok: true,
    kind: 'started',
    row: { id: input.timerId, quote_id: input.quoteId ?? null, sent_at: null },
  }));
  // Default the update-branch row to a plain draft (no lifecycle timestamps) so
  // the existing UUID→update tests still re-price; booked/terminal cases set it.
  rawRef.current = {
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: null,
    status: null,
    service_type: null,
    result: null,
  };
});

// A valid permanent inputs block (holiday fields present + zeroed, per QuoteInputs).
function permInputs(front = 100): Record<string, unknown> {
  return {
    ...validInputs(),
    permanent: {
      frontFootage: front,
      leftFootage: 0,
      rightFootage: 0,
      backFootage: 0,
      gaps: [],
      controllerToFirstLightFt: 0,
      frontCorners: 0,
      leftCorners: 0,
      rightCorners: 0,
      backCorners: 0,
      trackStyle: 'single',
      trackColor: '9003',
      blackHousing: false,
      maintenanceAddOn: false,
    },
  };
}

type Line = { id?: string; amount: number };
const savedResult = () => save.mock.calls[0]?.[2] as { lineItems: Line[]; permanentRatesSnapshot?: unknown };
const updatedResult = () => update.mock.calls[0]?.[2] as { lineItems: Line[]; permanentRatesSnapshot?: unknown };
const frontAmt = (r: { lineItems: Line[] }) => r.lineItems.find((l) => l.id === 'permanent-front')?.amount;

describe('POST /api/quote — permanent dispatch (#88 P4a)', () => {
  it('a NEW permanent quote is priced by the permanent engine at live rates + saved as permanent', async () => {
    const res = await POST(makeReq({ serviceType: 'permanent', inputs: permInputs(100) }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(frontAmt(savedResult())).toBe(4000); // 100 * $40
    expect(savedResult().permanentRatesSnapshot).toBeTruthy(); // rates frozen
    expect(save.mock.calls[0]?.[3]).toBe('permanent'); // serviceType arg
    expect(update).not.toHaveBeenCalled();
  });

  it('a holiday quote is untouched — no permanent line, no snapshot (regression)', async () => {
    await POST(makeReq({ serviceType: 'holiday', inputs: permInputs(100) }));
    expect(frontAmt(savedResult())).toBeUndefined();
    expect(savedResult().permanentRatesSnapshot).toBeUndefined();
    expect(save.mock.calls[0]?.[3]).toBe('holiday');
  });

  it('H2: an UPDATE that OMITS serviceType prices by the STORED type (permanent), not the holiday engine', async () => {
    rawRef.current!.service_type = 'permanent';
    const res = await POST(makeReq({ quoteId: REAL_UUID, inputs: permInputs(100) })); // no serviceType in body
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(frontAmt(updatedResult())).toBe(4000); // permanent engine ran
    expect(update.mock.calls[0]?.[4]).toBe('permanent'); // stored type written back
  });

  it('H1: an UPDATE of an existing permanent quote prices from the FROZEN snapshot, not live settings', async () => {
    rawRef.current!.service_type = 'permanent';
    rawRef.current!.result = {
      permanentRatesSnapshot: { frontPerFt: 99, sidesPerFt: 99, backPerFt: 99, minimumJobAmount: 2500, maintenancePrice: 0 },
    };
    await POST(makeReq({ quoteId: REAL_UUID, serviceType: 'permanent', inputs: permInputs(100) }));
    expect(frontAmt(updatedResult())).toBe(9900); // 100 * $99 (snapshot) — NOT 100 * $40 (live)
  });
});

const eventRooflineAmt = (r: { lineItems: Line[] }) =>
  r.lineItems.find((l) => l.id === 'roofline-santas')?.amount;

describe('POST /api/quote — event dispatch (#96 Phase B)', () => {
  it('a NEW event quote is priced by the event engine at live event rates + saved as event, snapshot frozen', async () => {
    const inputs = { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(eventRooflineAmt(savedResult())).toBe(500); // 100 * $5 (settings event rate, not $7 default or $8 holiday)
    expect((savedResult() as { eventRatesSnapshot?: unknown }).eventRatesSnapshot).toBeTruthy();
    expect(save.mock.calls[0]?.[3]).toBe('event'); // saved as event
    expect(update).not.toHaveBeenCalled();
  });

  it('H1: an UPDATE of an existing event quote prices from the FROZEN snapshot, not live settings', async () => {
    rawRef.current!.service_type = 'event';
    rawRef.current!.result = {
      eventRatesSnapshot: {
        roofline: { easy: 3, medium: 3, hard: 3 },
        mini: { canopy: 20, trunk: 20 },
        spritzer: { '16': 40, '24': 40, '32': 40 },
        bistroPerFt: 8,
        barrelBoxPrice: 100,
      },
    };
    const inputs = { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' };
    await POST(makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs }));
    expect(eventRooflineAmt(updatedResult())).toBe(300); // 100 * $3 (snapshot) — NOT $5 (live)
    expect(update.mock.calls[0]?.[4]).toBe('event'); // stored type written back
  });
});

describe('POST /api/quote — permanent block validation (#88 P4b)', () => {
  // Mutate one field of an otherwise-valid permanent block and expect a 400.
  const badPerm = (patch: Record<string, unknown>) => {
    const inputs = permInputs(100);
    inputs.permanent = { ...(inputs.permanent as Record<string, unknown>), ...patch };
    return makeReq({ serviceType: 'permanent', inputs });
  };

  it('rejects an invalid trackColor with 400', async () => {
    const res = await POST(badPerm({ trackColor: '0000' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an invalid trackStyle with 400', async () => {
    const res = await POST(badPerm({ trackStyle: 'diagonal' }));
    expect(res.status).toBe(400);
  });

  it('rejects a negative footage with 400', async () => {
    const res = await POST(badPerm({ leftFootage: -5 }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean blackHousing with 400', async () => {
    const res = await POST(badPerm({ blackHousing: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range custom rate with 400', async () => {
    const res = await POST(badPerm({ frontCustomRate: 99999 }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed gaps element (no lengthFt) with 400', async () => {
    const res = await POST(badPerm({ gaps: [{ splitter: true }] }));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed permanent block with optional custom rate + gaps', async () => {
    const inputs = permInputs(120);
    inputs.permanent = {
      ...(inputs.permanent as Record<string, unknown>),
      frontCustomRate: 45,
      gaps: [{ lengthFt: 12, splitter: true, source: 'manual' }],
    };
    const res = await POST(makeReq({ serviceType: 'permanent', inputs }));
    expect(res.status).toBe(200);
  });

  // #192 — per-side track style: trackStyleBySide validation trio.
  it('rejects a non-object trackStyleBySide with 400', async () => {
    const res = await POST(badPerm({ trackStyleBySide: 'single' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  // #674 review (technical LOW) — isObj() alone admits arrays (typeof [] ===
  // 'object'); every other object-shaped field in this route additionally
  // rejects Array.isArray (see lineItemPriceOverrides ~line 219). trackStyleBySide
  // was missing that guard.
  it('rejects an ARRAY trackStyleBySide with 400 (isObj alone admits arrays)', async () => {
    const res = await POST(badPerm({ trackStyleBySide: [] }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an invalid VALUE on a recognized trackStyleBySide side with 400', async () => {
    const res = await POST(badPerm({ trackStyleBySide: { front: 'diagonal' } }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a well-formed trackStyleBySide, ignoring an unknown key', async () => {
    const inputs = permInputs(120);
    inputs.permanent = {
      ...(inputs.permanent as Record<string, unknown>),
      trackStyleBySide: { front: 'parapet', left: 'single', notASide: 'parapet' },
    };
    const res = await POST(makeReq({ serviceType: 'permanent', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/quote — event block validation (#96 audit fixes #9 / #5)', () => {
  it('rejects an over-cap event.bistro array (length 501) with 400', async () => {
    const inputs = validInputs();
    inputs.event = { bistro: Array.from({ length: 501 }, () => ({ footage: 10 })) };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a malformed bistro element (non-numeric footage) with 400', async () => {
    const inputs = validInputs();
    inputs.event = { bistro: [{ footage: 'ten' }] };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a negative event.barrelBoxes with 400', async () => {
    const inputs = validInputs();
    inputs.event = { barrelBoxes: -1 };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
  });

  it('rejects inverted event dates (eventDate before installDate) with 400', async () => {
    const inputs = validInputs();
    inputs.event = { installDate: '2026-08-10', eventDate: '2026-08-05', takedownDate: '2026-08-11' };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects inverted event dates (takedownDate before eventDate) with 400', async () => {
    const inputs = validInputs();
    inputs.event = { eventDate: '2026-08-10', takedownDate: '2026-08-05' };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date string with 400', async () => {
    const inputs = validInputs();
    inputs.event = { installDate: '08/10/2026' };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed event block with in-order dates + bistro + barrelBoxes', async () => {
    const inputs = validInputs();
    inputs.event = {
      bistro: [{ footage: 20 }],
      barrelBoxes: 2,
      installDate: '2026-08-01',
      eventDate: '2026-08-05',
      takedownDate: '2026-08-05', // equal dates (single-day event) must be allowed
    };
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('accepts an event quote with no event block at all (still optional)', async () => {
    const inputs = validInputs();
    const res = await POST(makeReq({ serviceType: 'event', inputs }));
    expect(res.status).toBe(200);
  });
});

const bistroPoleAmt = (r: { lineItems: Line[] }) =>
  r.lineItems.find((l) => l.id === 'permanent-bistro-poles')?.amount;

describe('POST /api/quote — permanent_bistro dispatch (#117)', () => {
  it('a NEW permanent_bistro quote is priced by the bistro engine at live settings rates + saved as permanent_bistro, snapshot frozen', async () => {
    const inputs = { ...validInputs(), permanentBistro: { poles: 2 } };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(bistroPoleAmt(savedResult())).toBe(40); // 2 * $20 (settings rate, not $100 default)
    expect((savedResult() as { permanentBistroRatesSnapshot?: unknown }).permanentBistroRatesSnapshot).toBeTruthy();
    expect(save.mock.calls[0]?.[3]).toBe('permanent_bistro'); // saved as permanent_bistro
    expect(update).not.toHaveBeenCalled();
  });

  it('H1: an UPDATE of an existing permanent_bistro quote prices from the FROZEN snapshot, not live settings', async () => {
    rawRef.current!.service_type = 'permanent_bistro';
    rawRef.current!.result = {
      permanentBistroRatesSnapshot: { perFt: 30, perPole: 99, minimum: 0 },
    };
    const inputs = { ...validInputs(), permanentBistro: { poles: 2 } };
    await POST(makeReq({ quoteId: REAL_UUID, serviceType: 'permanent_bistro', inputs }));
    expect(bistroPoleAmt(updatedResult())).toBe(198); // 2 * $99 (snapshot) — NOT 2 * $20 (live)
    expect(update.mock.calls[0]?.[4]).toBe('permanent_bistro'); // stored type written back
  });
});

describe('POST /api/quote — permanentBistro block validation (#117)', () => {
  it('rejects an over-cap permanentBistro.bistro array (length 501) with 400', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { bistro: Array.from({ length: 501 }, () => ({ footage: 10 })) };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a malformed bistro element (non-numeric footage) with 400', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { bistro: [{ footage: 'ten' }] };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a negative poles with 400', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { poles: -1 };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed permanentBistro block with bistro + poles', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { bistro: [{ footage: 20 }], poles: 2 };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('accepts a permanent_bistro quote with no permanentBistro block at all (still optional)', async () => {
    const inputs = validInputs();
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(200);
  });
});

// #117 satellite migration: bistro footage now bills from the client-sent
// satellite-derived inputs.permanentBistro.bistro (true-scale polylines drawn
// on the Satellite tab), never from a linked design's street-photo scene — the
// Design tab's bistro strand there is visual-only for the portal. The route's
// design-projection gate (`!isPermanent && !isPermanentBistro && isValidDesignId`)
// must skip getDesign/applyProjectionToInputs entirely for permanent_bistro, so
// a design's projected bistro footage can never clobber the client-sent value.
describe('POST /api/quote — permanent_bistro design-projection exemption (#117)', () => {
  const DESIGN_ID = 'ffffffff-2222-4ccc-8ddd-eeeeeeeeeeee';
  const bistroAmt = (r: { lineItems: Line[] }) =>
    r.lineItems.find((l) => (l.id ?? '').toString().startsWith('permanent-bistro-') && l.id !== 'permanent-bistro-poles')
      ?.amount;

  function designSceneWithBistroStrand() {
    return {
      yardsticks: [],
      items: [
        {
          id: 'b1',
          kind: 'strand',
          yardstickId: null,
          bulbType: 'bistro',
          spacingIn: 6,
          drawingStyle: 'strand',
          colorPattern: [],
          // 600px ÷ the 50px/ft no-yardstick fallback = 12ft — a DIFFERENT
          // number than the client-sent 20ft below, so a passing assertion
          // proves whichever number wins.
          points: [0, 0, 600, 0],
        },
      ],
    };
  }

  it('a bistro quote client-sent inputs.permanentBistro.bistro survives Calculate even when a linked design exists', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({ id: DESIGN_ID, scene: designSceneWithBistroStrand() });

    const inputs = { ...validInputs(), permanentBistro: { bistro: [{ footage: 20 }] } };
    const res = await POST(makeReq({ designId: DESIGN_ID, serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(200);

    // getDesign must never be consulted for permanent_bistro — the gate skips
    // the whole design-projection branch before it's reached.
    expect(getDesignMock).not.toHaveBeenCalled();

    // 20ft (client-sent, live settings perFt=$6) = $120 — NOT 12ft/$72 (what the
    // design's bistro strand would have projected to).
    expect(bistroAmt(savedResult())).toBe(120);
  });

  it('event projection behavior is unchanged: a linked design bistro strand STILL projects for an event quote', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({ id: DESIGN_ID, scene: designSceneWithBistroStrand() });

    const inputs = validInputs();
    const res = await POST(makeReq({ designId: DESIGN_ID, serviceType: 'event', inputs }));
    expect(res.status).toBe(200);

    // Event still routes through getDesign → applyProjectionToInputs.
    expect(getDesignMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { result: { lineItems: Line[] } };
    const bistroLine = body.result.lineItems.find((l) => (l.id ?? '').toString().startsWith('bistro-'));
    // 12ft (projected from the 600px strand) * $8/ft (settings eventRates.bistroPerFt) = $96.
    expect(bistroLine?.amount).toBe(96);
  });
});

describe('POST /api/quote — validation hardening', () => {
  it('routes a non-UUID quoteId to insert, not update', async () => {
    // 36 dashes used to slip past the old loose /^[0-9a-f-]{36}$/i regex.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: '-'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('routes a canonical UUID quoteId to update', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  // #839 fix-round MED: updateQuote's identityFrozen flag (set when the #251
  // freeze actually refused a would-be reattach) must reach the client so the
  // builder can show a notice instead of the save silently succeeding.
  it('propagates identityFrozen:true from updateQuote onto the response', async () => {
    update.mockResolvedValueOnce({ id: 'existing-id', identityFrozen: true });
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.identityFrozen).toBe(true);
  });

  it('omits identityFrozen from the response when updateQuote did not set it', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.identityFrozen).toBeUndefined();
  });

  it('rejects an over-cap input array (length 501) with 400', async () => {
    const inputs = validInputs();
    inputs.spritzers = Array.from({ length: 501 }, () => ({ size: '16', quantity: 1 }));
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a malformed wreath element with 400', async () => {
    const inputs = validInputs();
    inputs.wreaths = [{ size: 'not-a-size', tier: 'bow', quantity: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a well-formed wreath element', async () => {
    const inputs = validInputs();
    inputs.wreaths = [{ size: '24noble', tier: 'fullDecor', quantity: 2 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid custom $/ft override (#102)', async () => {
    const inputs = validInputs();
    inputs.santasFootage = 100;
    inputs.santasCustomRate = 5;
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-numeric / out-of-range custom $/ft with 400 (#102)', async () => {
    for (const bad of ['5', -1, 1001, NaN, Infinity]) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.stakeLightingCustomRate = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('accepts a valid depositPercent override (#177)', async () => {
    const inputs = validInputs();
    inputs.depositPercent = 25;
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-integer / out-of-range depositPercent with 400 (#177)', async () => {
    for (const bad of ['50', -1, 0, 101, 12.5, NaN, Infinity]) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.depositPercent = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('accepts a valid lineItemPriceOverrides map (#104)', async () => {
    const inputs = validInputs();
    inputs.lineItemPriceOverrides = { 'spritzer-1': { amount: 0, reason: 'comp' }, 'roofline-santas': { amount: 600 } };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('returns a baseline with the overrides stripped (#104)', async () => {
    const inputs = validInputs();
    inputs.spritzers = [{ size: '24', quantity: 1, id: 'spritzer-x' }];
    inputs.lineItemPriceOverrides = { 'spritzer-x': { amount: 0 } };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { lineItems: { id?: string; amount: number }[] };
      baseline: { lineItems: { id?: string; amount: number }[] };
    };
    expect(body.result.lineItems.find((li) => li.id === 'spritzer-x')!.amount).toBe(0); // override applied
    expect(body.baseline.lineItems.find((li) => li.id === 'spritzer-x')!.amount).toBe(95); // baseline stripped
  });

  it('rejects a malformed lineItemPriceOverrides with 400 (#104)', async () => {
    const bads: unknown[] = [
      [], // array, not object
      { x: 5 }, // value not an object
      { x: { amount: -1 } }, // negative
      { x: { amount: NaN } }, // NaN
      { x: { amount: 'free' } }, // non-number
      { x: { amount: 5, reason: 42 } }, // non-string reason
    ];
    for (const bad of bads) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.lineItemPriceOverrides = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('accepts a valid labelOverrides map, incl. an empty-string value (item-numbering-rename)', async () => {
    const inputs = validInputs();
    inputs.labelOverrides = { 'mini-1': 'Front Left Tree', 'wreath-1': '' };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('renamed mini item flows through to the returned result label (item-numbering-rename)', async () => {
    const inputs = validInputs();
    inputs.miniLightItems = [{ type: 'tree', wrapStyle: 'canopy', stringCount: 1, id: 'mini-x' }];
    inputs.labelOverrides = { 'mini-x': 'Front Left Tree' };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { lineItems: { id?: string; label: string }[] } };
    // The ENGINE's own label stays the default (kind classification safety) —
    // the override is applied by the portal adapter/UI display layer, not here.
    expect(body.result.lineItems.find((li) => li.id === 'mini-x')!.label).toBe('Tree – canopy wrap, 1 string');
  });

  it('rejects a malformed labelOverrides with 400 (item-numbering-rename)', async () => {
    const bads: unknown[] = [
      [], // array, not object
      { x: 5 }, // value not a string
      { x: 'a'.repeat(201) }, // over the 200-char cap
    ];
    for (const bad of bads) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.labelOverrides = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });
});

describe('POST /api/quote — created_by actor trail (#90)', () => {
  it('threads the authenticated operator id to saveQuote as created_by', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    // saveQuote(customer, inputs, result, serviceType, isTest, created_by, referredByCustomerId, highlevelContactId, legacyRebook, isNce)
    expect(save).toHaveBeenCalledWith(
      expect.anything(), // customer
      expect.anything(), // inputs
      expect.anything(), // result
      expect.anything(), // serviceType
      expect.anything(), // isTest
      'op-1', // created_by
      null, // referredByCustomerId (#41) — not supplied in this request
      null, // highlevelContactId (#leads) — not supplied in this request
      undefined, // legacyRebook (#198) — not supplied in this request
      undefined, // isNce (#198) — not supplied in this request
    );
  });

  it('threads null when no operator session (dormant auth)', async () => {
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      null,
      null,
      null,
      undefined,
      undefined,
    );
  });
});

describe('POST /api/quote — quote build timer association', () => {
  it('creates or reuses the owned timer on a new quote before reporting save success', async () => {
    const timerId = '11111111-2222-4333-8444-555555555555';
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    let releaseStart!: (value: {
      ok: true;
      kind: 'started';
      row: { id: string; quote_id: string; sent_at: null };
    }) => void;
    startQuoteBuildSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseStart = resolve;
      }),
    );
    let settled = false;

    const pending = POST(makeReq({
      inputs: validInputs(),
      quoteBuildTimerId: timerId,
      quoteBuildStartReason: 'contact_selected',
    }))
      .then((response) => {
        settled = true;
        return response;
      });

    await vi.waitFor(() => expect(startQuoteBuildSession).toHaveBeenCalledWith({
      timerId,
      startReason: 'contact_selected',
      quoteId: 'new-id',
      operator: { id: 'op-1', email: 'a@b.com', role: 'operator' },
      startedAt: expect.any(String),
    }));
    expect(settled).toBe(false);

    releaseStart({
      ok: true,
      kind: 'started',
      row: { id: timerId, quote_id: 'new-id', sent_at: null },
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed timer id before saving', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteBuildTimerId: 'not-a-uuid' }));

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('requires the timer id and start reason together', async () => {
    const res = await POST(makeReq({
      inputs: validInputs(),
      quoteBuildTimerId: '11111111-2222-4333-8444-555555555555',
    }));

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('links the timer on an existing saved draft too', async () => {
    const timerId = '11111111-2222-4333-8444-555555555555';
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    rawRef.current = {
      ...rawRef.current!,
      is_test: false,
      view_only: false,
    };

    const res = await POST(makeReq({
      inputs: validInputs(),
      quoteId: REAL_UUID,
      quoteBuildTimerId: timerId,
      quoteBuildStartReason: 'contact_selected',
    }));

    expect(res.status).toBe(200);
    expect(startQuoteBuildSession).toHaveBeenCalledWith({
      timerId,
      startReason: 'contact_selected',
      quoteId: 'existing-id',
      operator: { id: 'op-1', email: 'a@b.com', role: 'operator' },
      startedAt: expect.any(String),
    });
  });

  it('never associates a timer to a test quote', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };

    const res = await POST(makeReq({
      inputs: validInputs(),
      isTest: true,
      quoteBuildTimerId: '11111111-2222-4333-8444-555555555555',
      quoteBuildStartReason: 'contact_selected',
    }));

    expect(res.status).toBe(200);
    expect(linkQuoteBuildSession).not.toHaveBeenCalled();
  });

  it('links an earlier unlinked start and completes it when Send wins during save', async () => {
    const timerId = '11111111-2222-4333-8444-555555555555';
    const sentAt = '2026-08-21T12:10:00.000Z';
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    startQuoteBuildSession.mockResolvedValueOnce({
      ok: true,
      kind: 'existing',
      row: { id: timerId, quote_id: null, sent_at: null },
    });
    quoteBuildSessionTargetState.mockResolvedValueOnce({ kind: 'sent', sentAt });

    const res = await POST(makeReq({
      inputs: validInputs(),
      quoteBuildTimerId: timerId,
      quoteBuildStartReason: 'contact_selected',
    }));

    expect(res.status).toBe(200);
    expect(linkQuoteBuildSession).toHaveBeenCalledWith({
      timerId,
      quoteId: 'new-id',
      operatorId: 'op-1',
    });
    expect(completeQuoteBuildSession).toHaveBeenCalledWith({
      quoteId: 'new-id',
      timerId,
      operatorId: 'op-1',
      sentAt,
    });
  });
});

describe('POST /api/quote — referredByCustomerId (#41 "mention" attribution)', () => {
  it('threads a valid referredByCustomerId to saveQuote', async () => {
    const referrerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const res = await POST(makeReq({ inputs: validInputs(), referredByCustomerId: referrerId }));
    expect(res.status).toBe(200);
    // Note: expect.anything() does NOT match null, so the no-operator-session
    // created_by arg (position 6) needs the literal `null` here.
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      null,
      referrerId,
      null,
      undefined,
      undefined,
    );
  });

  it('400s when referredByCustomerId is not a valid UUID', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), referredByCustomerId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s when referredByCustomerId is not a string', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), referredByCustomerId: 123 }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('also threads referredByCustomerId to updateQuote on the UPDATE path (#41 adversarial-review fix — was previously dropped)', async () => {
    const referrerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, referredByCustomerId: referrerId }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    // updateQuote(id, inputs, result, customer, serviceType, referredByCustomerId)
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[5]).toBe(referrerId);
  });
});

describe('POST /api/quote — highlevelContactId (#leads "Create quote" link)', () => {
  it('threads a valid highlevelContactId to saveQuote (8th arg)', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), highlevelContactId: 'ghl-contact-abc123' }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      null,
      null,
      'ghl-contact-abc123',
      undefined,
      undefined,
    );
  });

  it('trims whitespace and defaults to null when blank', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), highlevelContactId: '   ' }));
    expect(res.status).toBe(200);
    expect((save.mock.calls[0] as unknown[])[7]).toBeNull();
  });

  it('400s when highlevelContactId is not a string', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), highlevelContactId: 123 }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s when highlevelContactId exceeds the length cap', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), highlevelContactId: 'x'.repeat(101) }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  // #214: the update path now RECEIVES the session's hl link — as
  // updateQuote's identity-resolution input only (updateQuote never writes
  // the highlevel_contact_id column; the attach route stays that column's
  // post-insert writer). Tri-state on the wire: string = linked this
  // session · explicit null = session has NO contact (never fall back to
  // the stored id) · absent = legacy caller (updateQuote falls back to the
  // stored id).
  it('threads highlevelContactId to updateQuote (9th arg) on the UPDATE path', async () => {
    const res = await POST(
      makeReq({ inputs: validInputs(), quoteId: REAL_UUID, highlevelContactId: 'ghl-contact-abc123' }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    // updateQuote(id, inputs, result, customer, serviceType, referredByCustomerId,
    // legacyRebook, isNce, hlContactId)
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[8]).toBe('ghl-contact-abc123');
  });

  it('accepts an EXPLICIT null and threads it through (session cleared the contact)', async () => {
    const res = await POST(
      makeReq({ inputs: validInputs(), quoteId: REAL_UUID, highlevelContactId: null }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[8]).toBeNull();
  });

  it('threads undefined when the key is ABSENT (legacy caller — updateQuote falls back to the stored id)', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[8]).toBeUndefined();
  });

  it('a blank string collapses to null (not a stored-id fallback) on the update path', async () => {
    const res = await POST(
      makeReq({ inputs: validInputs(), quoteId: REAL_UUID, highlevelContactId: '   ' }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[8]).toBeNull();
  });
});

describe('POST /api/quote — NCE + YLL Neighbor tags (#198)', () => {
  it('threads legacyRebook/isNce to saveQuote (9th/10th args) on a NEW save', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), legacyRebook: true, isNce: true }));
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[8]).toBe(true); // legacyRebook
    expect(saveArgs[9]).toBe(true); // isNce
  });

  it('defaults to undefined (saveQuote applies its own false default) when omitted', async () => {
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[8]).toBeUndefined();
    expect(saveArgs[9]).toBeUndefined();
  });

  it('threads legacyRebook/isNce to updateQuote (7th/8th args) on the UPDATE path too — unlike highlevelContactId, tags ARE settable on a reopened quote', async () => {
    const res = await POST(
      makeReq({ inputs: validInputs(), quoteId: REAL_UUID, legacyRebook: false, isNce: true }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[6]).toBe(false); // legacyRebook
    expect(updateArgs[7]).toBe(true); // isNce
  });

  it('leaves the stored tags untouched on an update that omits them (undefined, not false)', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[6]).toBeUndefined();
    expect(updateArgs[7]).toBeUndefined();
  });

  it('400s on a non-boolean legacyRebook', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), legacyRebook: 'yes' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s on a non-boolean isNce', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), isNce: 'yes' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — NCE/YLL Neighbor holiday-only gate (#243)', () => {
  it('clamps an explicit true legacyRebook/isNce to false on a NEW permanent-service-type save', async () => {
    const res = await POST(
      makeReq({ serviceType: 'permanent', inputs: permInputs(100), legacyRebook: true, isNce: true }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[8]).toBe(false); // legacyRebook — clamped
    expect(saveArgs[9]).toBe(false); // isNce — clamped
  });

  it.each([['event'], ['permanent_bistro']])(
    'clamps an explicit true legacyRebook/isNce to false on a NEW %s save too',
    async (st) => {
      const res = await POST(
        makeReq({ serviceType: st, inputs: validInputs(), legacyRebook: true, isNce: true }),
      );
      expect(res.status).toBe(200);
      const saveArgs = save.mock.calls[0] as unknown[];
      expect(saveArgs[8]).toBe(false);
      expect(saveArgs[9]).toBe(false);
    },
  );

  it('still honors an explicit true legacyRebook/isNce on a NEW holiday save (regression)', async () => {
    const res = await POST(
      makeReq({ serviceType: 'holiday', inputs: validInputs(), legacyRebook: true, isNce: true }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[8]).toBe(true);
    expect(saveArgs[9]).toBe(true);
  });

  it('clamps an explicit true legacyRebook/isNce to false on an UPDATE of an existing permanent quote', async () => {
    rawRef.current!.service_type = 'permanent';
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, inputs: permInputs(100), legacyRebook: true, isNce: true }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[6]).toBe(false); // legacyRebook — clamped
    expect(updateArgs[7]).toBe(false); // isNce — clamped
  });

  // The gate must NEVER touch an OMITTED tag — an untouched chip already
  // means "leave the stored value alone" (resolveTagPayload), and clamping
  // `undefined` to `false` here would silently correct an EXISTING violating
  // row's tag as a side effect of an unrelated save (exactly what the ledger
  // row's "do not silently mutate existing rows" instruction forbids).
  it('does NOT clamp an OMITTED (undefined) legacyRebook/isNce on an update of an existing permanent quote', async () => {
    rawRef.current!.service_type = 'permanent';
    const res = await POST(makeReq({ quoteId: REAL_UUID, inputs: permInputs(100) }));
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[6]).toBeUndefined();
    expect(updateArgs[7]).toBeUndefined();
  });

  it('does NOT clamp an explicit FALSE legacyRebook/isNce on an update of an existing permanent quote — turning OFF is never gated', async () => {
    rawRef.current!.service_type = 'permanent';
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, inputs: permInputs(100), legacyRebook: false, isNce: false }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[6]).toBe(false);
    expect(updateArgs[7]).toBe(false);
  });
});

// Fix-round HIGH (two lenses converged): the #243 gate above clamps the
// is_nce COLUMN but previously left quoteInputs.depositPercent — the field
// effectiveDepositRate actually prices off — untouched, so a clamped-tag
// permanent/event/bistro quote could still persist depositPercent:40 with no
// tag left to explain it. Mirrors rebook.ts's buildRebookInsert/
// applyNceDepositDefault gateForcedNceOff semantics: reset ONLY an exact 40,
// ONLY when the tag gate itself is what forced isNce off.
describe('POST /api/quote — NCE-gated deposit-rate reset (#243 fix round)', () => {
  it('resets a carried depositPercent=40 to 0 when the gate clamps isNce off on a NEW permanent save', async () => {
    const res = await POST(
      makeReq({
        serviceType: 'permanent',
        inputs: { ...permInputs(100), depositPercent: 40 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[9]).toBe(false); // isNce — clamped (existing #243 behavior)
    const savedInputs = saveArgs[1] as { depositPercent?: number };
    expect(savedInputs.depositPercent).toBe(0); // NEW: deposit rate reset too
    // Prices off the corrected 0 (⇒ "no override" ⇒ the 50% default), not a
    // stale 40% — proves the reset lands BEFORE pricing, not just on the
    // saved row.
    const savedResultArg = saveArgs[2] as { depositRate: number };
    expect(savedResultArg.depositRate).toBe(0.5);
  });

  it('does NOT touch a hand-typed depositPercent that is not exactly 40, even when the gate clamps isNce off', async () => {
    const res = await POST(
      makeReq({
        serviceType: 'permanent',
        inputs: { ...permInputs(100), depositPercent: 25 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[9]).toBe(false); // isNce still clamped
    const savedInputs = saveArgs[1] as { depositPercent?: number };
    expect(savedInputs.depositPercent).toBe(25); // untouched — a legit staff override
  });

  it('does NOT reset depositPercent=40 when isNce is omitted (no explicit true ⇒ gate never fires) — a genuinely hand-typed 40% survives', async () => {
    const res = await POST(
      makeReq({
        serviceType: 'permanent',
        inputs: { ...permInputs(100), depositPercent: 40 },
        // isNce intentionally omitted
      }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[9]).toBeUndefined(); // untouched, not clamped
    const savedInputs = saveArgs[1] as { depositPercent?: number };
    expect(savedInputs.depositPercent).toBe(40); // left alone
  });

  it('does NOT reset depositPercent=40 on an eligible (holiday) save even with isNce:true — the gate never fires', async () => {
    const res = await POST(
      makeReq({
        serviceType: 'holiday',
        inputs: { ...validInputs(), depositPercent: 40 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    const saveArgs = save.mock.calls[0] as unknown[];
    expect(saveArgs[9]).toBe(true); // NCE legitimately on
    const savedInputs = saveArgs[1] as { depositPercent?: number };
    expect(savedInputs.depositPercent).toBe(40); // this IS the NCE rate — untouched
  });

  it('resets a carried depositPercent=40 to 0 on an UPDATE of an existing permanent quote too', async () => {
    rawRef.current!.service_type = 'permanent';
    const res = await POST(
      makeReq({
        quoteId: REAL_UUID,
        inputs: { ...permInputs(100), depositPercent: 40 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    expect(updateArgs[7]).toBe(false); // isNce — clamped
    const updatedInputs = updateArgs[1] as { depositPercent?: number };
    expect(updatedInputs.depositPercent).toBe(0);
  });

  // Delta-verify MED (sibling-guard parity): the #177 freeze above only 409s
  // when the INCOMING depositPercent DIFFERS from the stored one, so a plain
  // reopen-and-resave of an already-approved quote carrying a pre-existing
  // violation sails past it. Without the approval guard the reset would then
  // silently move an APPROVED customer's deposit from 40% to the 50% default.
  it('does NOT reset the deposit on an already-APPROVED quote — the #177 freeze owns it', async () => {
    rawRef.current!.service_type = 'permanent';
    rawRef.current!.customer_approved_at = '2026-01-02T00:00:00Z';
    // The stored deposit must ALSO be 40 — that is what makes this the real
    // scenario: the #177 freeze compares incoming vs stored and only 409s on a
    // DIFFERENCE, so a reopen-and-resave of the same hydrated values passes it
    // and reaches the reset. With a differing stored value the freeze 409s
    // first and the reset is never reached (verified: this test failed with a
    // 409 until the stored value matched).
    rawRef.current!.inputs = { depositPercent: 40 };
    const res = await POST(
      makeReq({
        quoteId: REAL_UUID,
        inputs: { ...permInputs(100), depositPercent: 40 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    const updateArgs = update.mock.calls[0] as unknown[];
    // The TAG is still clamped — that half is not deposit money and stays correct.
    expect(updateArgs[7]).toBe(false);
    // The DEPOSIT is left exactly as the approved customer agreed to it.
    const updatedInputs = updateArgs[1] as { depositPercent?: number };
    expect(updatedInputs.depositPercent).toBe(40);
  });

  it('warns via console.warn when the deposit reset fires, naming the quoteId', async () => {
    rawRef.current!.service_type = 'permanent';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({
        quoteId: REAL_UUID,
        inputs: { ...permInputs(100), depositPercent: 40 },
        isNce: true,
      }),
    );
    expect(res.status).toBe(200);
    // Not asserting the exact wording (a report, not a contract) — just that
    // a trace exists and names the affected quote, per the brief's "today
    // the clamp leaves no trace anywhere" concern.
    expect(warnSpy).toHaveBeenCalled();
    const warnedText = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(warnedText).toContain(REAL_UUID);
    warnSpy.mockRestore();
  });
});

describe('POST /api/quote — Test Quote flag (#93)', () => {
  it('threads isTest=true into the NEW-save path (saveQuote 5th arg)', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), isTest: true }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    // saveQuote(customer, inputs, result, serviceType, isTest)
    expect((save.mock.calls[0] as unknown[])[4]).toBe(true);
  });

  it('defaults isTest=false when the flag is absent', async () => {
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    expect((save.mock.calls[0] as unknown[])[4]).toBe(false);
  });

  it('does NOT pass is_test to the update branch (immutable on edit)', async () => {
    // An edit (canonical UUID) with isTest:true must still not re-flag the row —
    // updateQuote takes no is_test arg; the route only honors it on a fresh save.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, isTest: true }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s on a non-boolean isTest', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), isTest: 'yes' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — curtain minilight validation (W1-002)', () => {
  // The projection emits {type:'curtain'} mini inputs (#100); a design-linked
  // quote persists them, so on reopen the route must accept a curtain-typed
  // minilight instead of 400ing 'Invalid miniLightItems element'.
  it('accepts a curtain-typed minilight element (no longer 400)', async () => {
    const inputs = validInputs();
    inputs.miniLightItems = [{ type: 'curtain', wrapStyle: 'canopy', stringCount: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('still 400s a minilight with an unknown type', async () => {
    const inputs = validInputs();
    inputs.miniLightItems = [{ type: 'not-a-type', wrapStyle: 'canopy', stringCount: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

// W1-010: the #27 "design is the master item list" money path (route.ts ~398:
// getDesign → applyProjectionToInputs replacing the per-unit inputs before
// calculateQuote AND before saveQuote/updateQuote persists them) had zero
// route-level coverage — every other test in this file mocks isValidDesignId
// to false. A scene with one 48"-Noble fullDecor wreath (quoteSize/tier set,
// so no default-fallback ambiguity) prices at a known, unmistakable $705
// (BUSINESS_RULES.wreathPrices['48noble'].fullDecor) — a number nothing else
// in this file produces — so a passing assertion proves the PROJECTED scene
// drove pricing, not the manual body arrays.
describe('POST /api/quote — design-projection money path (W1-010)', () => {
  const DESIGN_ID = 'dddddddd-1111-4ccc-8ddd-eeeeeeeeeeee';

  // One projectable item (a wreath) with an explicit quoteSize/tier so the
  // projected mini/spritzer/garland arrays stay empty and the wreath price is
  // unambiguous ($705, not a defaulted size/tier).
  function designScene() {
    return {
      yardsticks: [],
      items: [
        {
          id: 'wreath-1',
          kind: 'wreath',
          yardstickId: null,
          x: 10,
          y: 10,
          sizeIn: 48,
          withLights: true,
          quoteSize: '48noble',
          tier: 'fullDecor',
        },
      ],
    };
  }

  const wreathLine = (r: { lineItems: Line[] }) =>
    r.lineItems.find((l) => l.id === 'wreath-wreath-1');

  it('prices the PROJECTED design items, not the manual body arrays, and persists the projected inputs', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({ id: DESIGN_ID, scene: designScene() });

    // The body's manual wreaths array asks for a cheap 24noble/bow ($200) —
    // if the route priced this instead of the projection, the assertions below
    // would see $200/1-manual-wreath instead of $705/the projected wreath.
    const inputs = validInputs();
    inputs.wreaths = [{ size: '24noble', tier: 'bow', quantity: 1 }];

    const res = await POST(makeReq({ designId: DESIGN_ID, inputs }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { lineItems: Line[] } };

    // (1) the response prices the PROJECTED items.
    expect(wreathLine(body.result)?.amount).toBe(705);
    expect(body.result.lineItems.some((l) => l.amount === 200)).toBe(false); // the manual wreath never priced

    // (2) saveQuote receives the PROJECTED inputs (wreaths array replaced).
    expect(save).toHaveBeenCalledTimes(1);
    const savedInputs = save.mock.calls[0]?.[1] as { wreaths: { size: string; tier: string; quantity: number }[] };
    expect(savedInputs.wreaths).toEqual([
      { size: '48noble', tier: 'fullDecor', quantity: 1, id: 'wreath-wreath-1', sceneItemIds: ['wreath-1'] },
    ]);
    expect(wreathLine(savedResult())?.amount).toBe(705);
  });

  it('replaces the projected inputs on an UPDATE too (updateQuote receives the projection)', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({ id: DESIGN_ID, scene: designScene() });

    const inputs = validInputs();
    inputs.wreaths = [{ size: '24noble', tier: 'bow', quantity: 1 }]; // stale manual value

    const res = await POST(makeReq({ quoteId: REAL_UUID, designId: DESIGN_ID, inputs }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(wreathLine(updatedResult())?.amount).toBe(705);
    const updatedInputs = update.mock.calls[0]?.[1] as { wreaths: { size: string; tier: string }[] };
    expect(updatedInputs.wreaths[0]?.size).toBe('48noble');
  });

  it('a body with projection-only shapes (a curtain minilight) still 200s once the design projects it', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({
      id: DESIGN_ID,
      scene: {
        yardsticks: [],
        items: [
          {
            id: 'curtain-1',
            kind: 'strand',
            yardstickId: null,
            bulbType: 'mini',
            spacingIn: 4,
            drawingStyle: 'strand',
            colorPattern: [],
            points: [0, 0, 10, 0],
            surface: 'curtain',
            wrapStyle: 'canopy',
            stringCount: 3,
          },
        ],
      },
    });

    // The manual body carries NO curtain items — the route must accept the
    // request purely because the PROJECTED scene contains one (W1-002's fix
    // validates the projected inputs, not just whatever the body sent).
    const inputs = validInputs();
    const res = await POST(makeReq({ designId: DESIGN_ID, inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    const savedInputs = save.mock.calls[0]?.[1] as { miniLightItems: { type: string }[] };
    expect(savedInputs.miniLightItems[0]?.type).toBe('curtain');
  });

  it('a permanent quote is NOT projected even when a valid design is linked (permanent skips projection)', async () => {
    designIdRef.current = true;
    getDesignMock.mockResolvedValue({ id: DESIGN_ID, scene: designScene() });
    const res = await POST(makeReq({ serviceType: 'permanent', designId: DESIGN_ID, inputs: permInputs(100) }));
    expect(res.status).toBe(200);
    expect(getDesignMock).not.toHaveBeenCalled();
    expect(wreathLine(savedResult())).toBeUndefined();
  });
});

describe('POST /api/quote — booked-quote re-price gate (W1-003)', () => {
  // A booked (deposit-paid) or terminal quote must NOT be silently re-priced in
  // place — that path skips the amendment trail + invoice re-sync + re-consent.
  // The route rejects it with 409 and points at the amend flow; draft/sent/etc.
  // still re-price fine.
  it('rejects re-pricing a booked (deposit-paid) quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: '2026-01-03T00:00:00Z',
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'booked',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(typeof body.error).toBe('string');
    expect(body.code).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects re-pricing a cancelled (terminal) quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'cancelled',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('still re-prices a draft quote in place', async () => {
    // rawRef defaults to a plain draft in beforeEach.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still re-prices a sent quote in place', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'sent',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still re-prices an approved-but-unbooked quote in place', async () => {
    // Approved (signed) but no deposit yet — staff can still legitimately re-price
    // before booking; only a paid deposit or a terminal state locks it.
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// Row 344 Part B: a scene-driven reprice (e.g. footage/corners, or a
// mini-light regroup routed through Calculate) of an approved-not-yet-booked
// quote is still ALLOWED (proven above — this row is not a new refusal), but
// must now surface a staff-facing signal + a durable audit entry. Mirrors the
// #177/row-331 suites' shape: base fixture approved-not-booked, one field
// changes the total, assert on the RESPONSE + the audit write instead of a
// 409.
describe('POST /api/quote — staff signal + audit trail for a post-approval reprice (row 344 Part B)', () => {
  const APPROVED_UNBOOKED_ROW = {
    quote_sent_at: '2026-01-01T00:00:00Z',
    customer_approved_at: '2026-01-02T00:00:00Z',
    deposit_paid_at: null,
    viewed_at: '2026-01-01T00:00:00Z',
    status: 'approved' as const,
    is_test: false,
    total: 1000,
    approval_snapshot: { customerSelection: { currentTotalUsd: 1000 } },
  };

  it('surfaces repricedAfterApproval + writes an audit entry when a footage edit actually moves the total', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { total: number };
      repricedAfterApproval?: {
        previousTotalUsd: number;
        newTotalUsd: number;
        deltaUsd: number;
        portalShowsFrozenPrice: boolean;
        hasAcceptedAmendment: boolean;
      };
    };
    // The engine isn't mocked — cross-check against whatever it actually
    // priced rather than hardcoding a dollar figure.
    expect(body.result.total).toBeGreaterThan(0);
    expect(body.repricedAfterApproval).toBeDefined();
    expect(body.repricedAfterApproval).toEqual({
      previousTotalUsd: 1000, // read from approval_snapshot.customerSelection.currentTotalUsd, NOT existing.total
      newTotalUsd: body.result.total,
      deltaUsd: body.result.total - 1000,
      // APPROVED_UNBOOKED_ROW's snapshot carries no `pricing` field — the
      // adapter's fallback fires, so the portal is already showing the NEW
      // price (staff-lens HIGH fix; see the companion test below for the
      // frozen-pricing-present case).
      portalShowsFrozenPrice: false,
      // No amendments at all pre-deposit — the OTHER reason
      // portalShowsFrozenPrice can be false (second fix round, staff-lens HIGH).
      hasAcceptedAmendment: false,
    });
    // Durable audit entry appended to approval_snapshot.postApprovalReprices —
    // the SAME sb.update() the GHL event-date stamp uses (mocked once, module-
    // wide), so assert on payload shape rather than call count.
    expect(sbUpdatePayloads).toContainEqual({
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 1000 },
        postApprovalReprices: [
          {
            at: expect.any(String),
            by: null, // no operator set in this test (operatorRef.current stays null)
            previous_total: 1000,
            new_total: body.result.total,
            delta: body.result.total - 1000,
          },
        ],
      },
    });
  });

  it('reports portalShowsFrozenPrice: true when the snapshot DOES carry frozen pricing', async () => {
    rawRef.current = {
      ...APPROVED_UNBOOKED_ROW,
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 1000 },
        // Presence alone is what adapter.ts checks (row.approval_snapshot?.pricing
        // ?? null) — shape doesn't matter to this route, only to the adapter.
        pricing: { total: 1000 },
      } as unknown as (typeof APPROVED_UNBOOKED_ROW)['approval_snapshot'],
    };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repricedAfterApproval?: { portalShowsFrozenPrice: boolean } };
    expect(body.repricedAfterApproval?.portalShowsFrozenPrice).toBe(true);
  });

  // Row 344 fix round (technical/admin-lens HIGH — negative control): the
  // original code built its update payload straight off `existing`, the row
  // read at REQUEST START. Prove the fix actually re-reads: land a
  // concurrent writer's field (a customer's pendingColorRequest, exactly the
  // apply-color-request.ts/color-change-request.ts column this HIGH named)
  // in the mocked re-fetch and assert it survives into the write instead of
  // being silently dropped by a stale-based payload.
  it('re-fetches approval_snapshot fresh right before writing — a concurrent writer field survives the merge', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW };
    freshApprovalSnapshotRef.current = {
      customerSelection: { currentTotalUsd: 1000 },
      pendingColorRequest: { colorSchemeId: 'red' },
    };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(200);
    const payload = sbUpdatePayloads.at(-1) as { approval_snapshot: Record<string, unknown> };
    // The concurrent writer's field made it into the write — proof the base
    // was the FRESH re-fetch, not the stale `existing` snapshot (which never
    // had pendingColorRequest at all).
    expect(payload.approval_snapshot.pendingColorRequest).toEqual({ colorSchemeId: 'red' });
    expect(payload.approval_snapshot.postApprovalReprices).toHaveLength(1);
  });

  it('drops the audit entry (no retry, no clobber) when it loses the CAS race to a concurrent approval_snapshot writer', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW };
    casResultRef.current = 'lose';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await POST(
        makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        repricedAfterApproval?: { previousTotalUsd: number; newTotalUsd: number; deltaUsd: number };
      };
      // The reprice SIGNAL never depends on the best-effort audit write
      // succeeding (matches the route's own "propagated even if the write
      // failed" comment).
      expect(body.repricedAfterApproval).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('reprice audit entry dropped'),
        REAL_UUID,
      );
      // Exactly one write attempt — a lost race is accepted and dropped,
      // never blindly retried (which could itself re-clobber whatever the
      // concurrent writer just landed).
      expect(sbUpdatePayloads).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT signal or write an audit entry when the resubmit does not actually change the total', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW };
    // Same footage as `total: 1000` implies nothing changed — validInputs()
    // (all-zero) already proved elsewhere in this file to reprice to the
    // SAME total the "still re-prices an approved-but-unbooked quote in
    // place" fixture used, so pin previousTotalUsd to match it exactly: 0.
    rawRef.current.total = 0;
    rawRef.current.approval_snapshot = { customerSelection: { currentTotalUsd: 0 } };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repricedAfterApproval?: unknown };
    expect(body.repricedAfterApproval).toBeUndefined();
    expect(sbUpdatePayloads).toHaveLength(0);
  });

  // Third fix round (technical-lens MED): a prior version of this route gated
  // the fresh fetch behind a cheap pre-check comparing newTotalUsd against
  // resolveAgreedTotal(existing.approval_snapshot, ...) — the STALE,
  // request-start snapshot. If a concurrent writer changed the TRUE agreed
  // basis, and this save's own new total happened to coincide with the STALE
  // previous value, that pre-check read "no change" and silently skipped the
  // fetch, the notice, AND the audit write — even though a real, unrecorded
  // divergence existed against the fresh basis. Construct exactly that shape:
  // validInputs() alone reprices to $0 (established above), so a STALE
  // snapshot claiming currentTotalUsd: 0 makes a stale-basis pre-check see
  // zero delta — while the FRESH snapshot (a concurrent staff correction)
  // claims 300, a REAL $300 divergence the fix must still catch.
  it('a concurrent write must not be masked by a stale-vs-new coincidence — the notice and the audit entry fire against the FRESH basis, not the stale one', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW };
    rawRef.current.total = 0;
    rawRef.current.approval_snapshot = { customerSelection: { currentTotalUsd: 0 } }; // stale: matches newTotalUsd (0)
    freshApprovalSnapshotRef.current = { customerSelection: { currentTotalUsd: 300 } }; // fresh: does NOT match
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repricedAfterApproval?: { previousTotalUsd: number; newTotalUsd: number; deltaUsd: number };
    };
    // Fires — a stale-basis pre-check would have suppressed this entirely.
    expect(body.repricedAfterApproval).toBeDefined();
    expect(body.repricedAfterApproval).toEqual({
      previousTotalUsd: 300, // the FRESH basis, not the stale 0
      newTotalUsd: 0,
      deltaUsd: -300,
      portalShowsFrozenPrice: false,
      hasAcceptedAmendment: false,
    });
    const payload = sbUpdatePayloads.at(-1) as { approval_snapshot: { postApprovalReprices: Array<{ previous_total: number; new_total: number; delta: number }> } };
    const persisted = payload.approval_snapshot.postApprovalReprices.at(-1)!;
    expect(persisted.previous_total).toBe(300);
    expect(persisted.new_total).toBe(0);
    expect(persisted.delta).toBe(-300);
  });

  it('is_test quotes are exempt — no signal, no audit write', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW, is_test: true };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repricedAfterApproval?: unknown };
    expect(body.repricedAfterApproval).toBeUndefined();
    expect(sbUpdatePayloads).toHaveLength(0);
  });

  it('a BOOKED quote (deposit already paid) never reaches this check — that reprice is either locked or the sanctioned amendReprice path', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW, status: 'booked' as const, deposit_paid_at: '2026-01-03T00:00:00Z' };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    // Booked + not amendReprice → REPRICE_LOCKED_STATUSES 409s before this
    // route ever reaches the row-344 check, so the audit write never fires.
    expect(res.status).toBe(409);
    expect(sbUpdatePayloads).toHaveLength(0);
  });

  it('an unapproved (draft/sent) quote is never signaled — this is a post-approval-only concern', async () => {
    rawRef.current = { ...APPROVED_UNBOOKED_ROW, customer_approved_at: null, status: 'sent' as const };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repricedAfterApproval?: unknown };
    expect(body.repricedAfterApproval).toBeUndefined();
    expect(sbUpdatePayloads).toHaveLength(0);
  });
});

// Row 344 fix round (technical-lens MED): QuoteBuilder.tsx sends
// `amendReprice: true` on EVERY save of a booked quote, not only the one
// save that immediately follows an accepted amendment. Once ANY amendment
// has been accepted, adapter.ts treats live row.result as unconditionally
// authoritative for the portal from then on — so a FURTHER scene edit that
// changes the total via this bypass, without a NEW amendment being recorded
// through /amend + /amend-consent, used to silently re-diverge what the
// portal shows with zero staff signal. The fix widens the SAME
// repricedAfterApproval gate to also cover this window, using
// resolveAgreedTotal (not the raw customerSelection figure) as the
// "previous" basis so an already-amended quote compares against what was
// actually last agreed, not the pre-amendment original.
describe('POST /api/quote — staff signal for a scene-driven reprice of a BOOKED, already-amended quote (row 344 fix round MED)', () => {
  const ACCEPTED_AMENDMENT = { new_total: 1200, delta: 200, consent: { status: 'accepted' } };
  const BOOKED_AMENDED_ROW = {
    quote_sent_at: '2026-01-01T00:00:00Z',
    customer_approved_at: '2026-01-02T00:00:00Z',
    deposit_paid_at: '2026-01-03T00:00:00Z',
    viewed_at: '2026-01-01T00:00:00Z',
    status: 'booked' as const,
    is_test: false,
    total: 1200,
    approval_snapshot: { amendments: [ACCEPTED_AMENDMENT] },
  };

  it('surfaces repricedAfterApproval, basis = the AMENDMENT total (not customerSelection/existing.total), portalShowsFrozenPrice: false', async () => {
    rawRef.current = { ...BOOKED_AMENDED_ROW };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' },
        quoteId: REAL_UUID,
        amendReprice: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { total: number };
      repricedAfterApproval?: {
        previousTotalUsd: number;
        newTotalUsd: number;
        deltaUsd: number;
        portalShowsFrozenPrice: boolean;
        hasAcceptedAmendment: boolean;
      };
    };
    expect(body.repricedAfterApproval).toBeDefined();
    expect(body.repricedAfterApproval).toEqual({
      previousTotalUsd: 1200, // the ACCEPTED amendment's new_total, via resolveAgreedTotal
      newTotalUsd: body.result.total,
      deltaUsd: body.result.total - 1200,
      // Once an amendment is accepted, adapter.ts ALWAYS shows live
      // row.result (never frozen) — the portal is already showing this new,
      // unrecorded price.
      portalShowsFrozenPrice: false,
      // The REASON portalShowsFrozenPrice is false here (second fix round,
      // staff-lens HIGH) — distinguishes this from the "no frozen pricing at
      // all" case below, so QuoteBuilder.tsx's notice can diagnose correctly.
      hasAcceptedAmendment: true,
    });
  });

  // Second fix round (technical-lens MED): the notice figures and the
  // persisted audit entry must come from the SAME basis. Simulate a
  // concurrent writer (another staffer recording+accepting a SECOND
  // amendment) landing between request-start (`existing`, which the mock
  // reads via getRaw) and the CAS re-fetch (freshApprovalSnapshotRef, per the
  // supabase mock's own doc comment above) — the notice's previousTotalUsd
  // AND the persisted entry's previous_total must both reflect the FRESH
  // amendment's new_total (1500), never the stale existing-based one (1200).
  it('the notice and the persisted audit entry agree on the SAME (fresh) basis when a concurrent amendment lands mid-request', async () => {
    rawRef.current = { ...BOOKED_AMENDED_ROW };
    const CONCURRENT_SECOND_AMENDMENT = { new_total: 1500, delta: 300, consent: { status: 'accepted' } };
    freshApprovalSnapshotRef.current = { amendments: [ACCEPTED_AMENDMENT, CONCURRENT_SECOND_AMENDMENT] };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' },
        quoteId: REAL_UUID,
        amendReprice: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { total: number };
      repricedAfterApproval?: { previousTotalUsd: number; deltaUsd: number };
    };
    // The notice: basis is the FRESH latest amendment (1500), not the stale
    // one existing (request-start) still held (1200).
    expect(body.repricedAfterApproval?.previousTotalUsd).toBe(1500);
    expect(body.repricedAfterApproval?.deltaUsd).toBe(body.result.total - 1500);
    // The persisted entry: same basis, same numbers — not a second, different
    // one computed some other way.
    const payload = sbUpdatePayloads.at(-1) as { approval_snapshot: { postApprovalReprices: Array<{ previous_total: number; new_total: number; delta: number }> } };
    const persisted = payload.approval_snapshot.postApprovalReprices.at(-1)!;
    expect(persisted.previous_total).toBe(1500);
    expect(persisted.new_total).toBe(body.result.total);
    expect(persisted.delta).toBe(body.result.total - 1500);
  });

  it('is inert (no signal) when this save does NOT reach the amendReprice bypass — a booked quote WITHOUT the flag still 409s before this code', async () => {
    rawRef.current = { ...BOOKED_AMENDED_ROW };
    const res = await POST(
      makeReq({ inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' }, quoteId: REAL_UUID }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { repricedAfterApproval?: unknown };
    expect(body.repricedAfterApproval).toBeUndefined();
  });

  it('a booked quote with NO amendment yet (first-ever amendReprice preview) still uses the pre-amendment logic: pricing presence gates portalShowsFrozenPrice', async () => {
    rawRef.current = {
      ...BOOKED_AMENDED_ROW,
      approval_snapshot: { pricing: { total: 1000 } }, // no amendments recorded yet
      total: 1000,
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), santasFootage: 100, santasDifficulty: 'easy' },
        quoteId: REAL_UUID,
        amendReprice: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repricedAfterApproval?: { portalShowsFrozenPrice: boolean } };
    expect(body.repricedAfterApproval?.portalShowsFrozenPrice).toBe(true);
  });
});

describe('POST /api/quote — deposit percent locked post-approval (#177 fix 3b)', () => {
  // The deposit percent is frozen into the approval snapshot the moment a
  // customer approves; a later edit here must not silently drift what was
  // signed. Scoped ONLY to depositPercent — every OTHER field on an
  // approved-but-not-yet-booked quote still re-prices fine (proven above by
  // "still re-prices an approved-but-unbooked quote in place").
  it('rejects a CHANGED depositPercent on an approved-but-unbooked quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { depositPercent: 25 },
    };
    const res = await POST(makeReq({ inputs: { ...validInputs(), depositPercent: 30 }, quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('deposit-percent-locked');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects ADDING a depositPercent override on an approved quote that had none (implicit 50%)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: {},
    };
    const res = await POST(makeReq({ inputs: { ...validInputs(), depositPercent: 25 }, quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows an UNCHANGED depositPercent resubmit on an approved quote (routine recalculate)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { depositPercent: 25 },
    };
    const res = await POST(makeReq({ inputs: { ...validInputs(), depositPercent: 25 }, quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('allows changing depositPercent on a NOT-YET-APPROVED (sent) quote', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'sent',
      inputs: { depositPercent: 25 },
    };
    const res = await POST(makeReq({ inputs: { ...validInputs(), depositPercent: 40 }, quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  // #226 round 2 (delta-verify HIGH): the #226 NCE-off fixes write an
  // EXPLICIT stored depositPercent: 0 (never a deleted key). The real
  // browser client can NEVER emit an explicit 0 — quoteForm.ts's
  // buildQuoteInputs only sends the key when `form.depositPercent > 0` — so
  // every ordinary re-save (fixing a typo, adjusting footage) on such a
  // quote omits depositPercent entirely. Before this fix, stored 0 vs
  // incoming undefined compared !== and 409'd on EVERY save, discarding the
  // unrelated edit. Both values mean "no override, use the 50% default" and
  // must now compare equal.
  it('allows a routine re-save (no depositPercent field at all) on an approved quote whose stored depositPercent is an explicit 0 (#226)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { depositPercent: 0 },
    };
    // Mirrors the REAL client shape: no depositPercent key at all (buildQuoteInputs
    // omits it whenever form.depositPercent is 0/blank) — validInputs() already
    // carries no depositPercent field.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  // Same starting state as above, but this time a GENUINE override is being
  // added on top of the reset-to-0 quote — the #177 freeze must still catch
  // it. Proves the fix didn't just widen the hole to admit every case.
  it('still rejects a GENUINE override added on top of a stored explicit 0 (#226 fix does not weaken #177)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { depositPercent: 0 },
    };
    const res = await POST(makeReq({ inputs: { ...validInputs(), depositPercent: 25 }, quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('deposit-percent-locked');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — post-approval freeze for price/label/bistro-footage overrides (rows 331+341)', () => {
  // Mirrors the #177 fix 3b deposit-percent-locked suite exactly: scoped ONLY
  // to these three fields actually changing — an unrelated field edit on an
  // approved-but-unbooked quote still re-prices fine (proven by the W1-003
  // "still re-prices an approved-but-unbooked quote in place" test above,
  // which sends no overrides at all and is unaffected by this freeze).

  it('rejects a CHANGED lineItemPriceOverrides amount on an approved quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { lineItemPriceOverrides: { 'mini-1': { amount: 100 } } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), lineItemPriceOverrides: { 'mini-1': { amount: 250 } } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('price-override-locked');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects ADDING a lineItemPriceOverrides entry on an approved quote that had none', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: {},
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), lineItemPriceOverrides: { 'mini-1': { amount: 250 } } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows an UNCHANGED lineItemPriceOverrides resubmit on an approved quote (routine recalculate)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { lineItemPriceOverrides: { 'mini-1': { amount: 100 } } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), lineItemPriceOverrides: { 'mini-1': { amount: 100 } } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('allows a lineItemPriceOverrides change on a NOT-YET-APPROVED (sent) quote', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'sent',
      inputs: { lineItemPriceOverrides: { 'mini-1': { amount: 100 } } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), lineItemPriceOverrides: { 'mini-1': { amount: 250 } } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('allows a lineItemPriceOverrides change on an approved TEST quote (is_test exempt, matching #251/#177)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      is_test: true,
      inputs: { lineItemPriceOverrides: { 'mini-1': { amount: 100 } } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), lineItemPriceOverrides: { 'mini-1': { amount: 250 } } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects a CHANGED labelOverrides value on an approved quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { labelOverrides: { 'mini-1': 'Front Left' } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), labelOverrides: { 'mini-1': 'Renamed' } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('label-override-locked');
    expect(update).not.toHaveBeenCalled();
  });

  it('allows an UNCHANGED labelOverrides resubmit on an approved quote', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      inputs: { labelOverrides: { 'mini-1': 'Front Left' } },
    };
    const res = await POST(
      makeReq({
        inputs: { ...validInputs(), labelOverrides: { 'mini-1': 'Front Left' } },
        quoteId: REAL_UUID,
      }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects a CHANGED permanentBistro run footage on an approved permanent_bistro quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      service_type: 'permanent_bistro',
      inputs: { permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }] } },
    };
    const inputs = { ...validInputs(), permanentBistro: { bistro: [{ id: 'run-1', footage: 65 }] } };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs, quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('bistro-footage-locked');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects ADDING a new bistro run on an approved permanent_bistro quote', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      service_type: 'permanent_bistro',
      inputs: { permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }] } },
    };
    const inputs = {
      ...validInputs(),
      permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }, { id: 'run-2', footage: 20 }] },
    };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs, quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows an UNCHANGED permanentBistro resubmit on an approved quote (routine recalculate)', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
      service_type: 'permanent_bistro',
      inputs: { permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }] } },
    };
    const inputs = { ...validInputs(), permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }] } };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs, quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('allows a permanentBistro footage change on a NOT-YET-APPROVED (sent) permanent_bistro quote', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'sent',
      service_type: 'permanent_bistro',
      inputs: { permanentBistro: { bistro: [{ id: 'run-1', footage: 40 }] } },
    };
    const inputs = { ...validInputs(), permanentBistro: { bistro: [{ id: 'run-1', footage: 65 }] } };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs, quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// FIX B (#237 fix round, staff/admin-lens HIGH/MED): the everyday reschedule
// — customer confirms/reschedules AFTER the quote already sent, staff edit
// the event date and hit Save (not Send) — used to leave GHL holding a stale
// date forever, because this route had zero HighLevel logic. Base fixture:
// an already-sent event quote with a linked contact and a real prior date.
const SENT_EVENT_ROW = {
  quote_sent_at: '2026-01-01T00:00:00Z',
  customer_approved_at: null,
  deposit_paid_at: null,
  viewed_at: null,
  status: 'sent',
  service_type: 'event',
  is_test: false,
  highlevel_contact_id: 'contact_1',
  inputs: { event: { eventDate: '2026-12-01' } },
};

describe('POST /api/quote — event-date GHL re-push on save (FIX B, #237 fix round)', () => {
  it('re-pushes when an already-sent event quote\'s date CHANGES', async () => {
    rawRef.current = { ...SENT_EVENT_ROW };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).toHaveBeenCalledWith('contact_1', '2026-12-25');
    // FIX A (#237 fix round 2, technical HIGH): proves the push is actually
    // scheduled via after(), not a bare `void` call that a platform could
    // reclaim before it completes — a regression back to a plain void call
    // would still make the assertion above pass (the mocked after() fires
    // the task either way), but afterCallCount would stay 0.
    expect(afterCallCount.current).toBe(1);
  });

  // #314 fix round (staff-lens HIGH): a confirmed push stamps
  // quotes.ghl_event_date_pushed — the marker the approve route's own
  // reconcile compares against instead of GHL's live value.
  it('stamps ghl_event_date_pushed when the re-push is confirmed', async () => {
    rawRef.current = { ...SENT_EVENT_ROW };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    await lastAfterTask.current;

    expect(sbUpdatePayloads).toContainEqual({ ghl_event_date_pushed: '12/25/2026' });
  });

  it('does NOT stamp ghl_event_date_pushed when the push fails', async () => {
    pushEventDateMock.mockResolvedValueOnce({ pushed: false });
    rawRef.current = { ...SENT_EVENT_ROW };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    await lastAfterTask.current;

    expect(sbUpdatePayloads).toHaveLength(0);
  });

  it('does NOT re-push when the date is unchanged (a routine unrelated re-save)', async () => {
    rawRef.current = { ...SENT_EVENT_ROW }; // stored eventDate is already 2026-12-01
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-01' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  it('re-pushes the FIRST real date entered on an already-sent quote that had none yet', async () => {
    rawRef.current = { ...SENT_EVENT_ROW, inputs: { event: {} } }; // no stored eventDate
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).toHaveBeenCalledWith('contact_1', '2026-12-25');
  });

  it('does NOT re-push when the new date is blank/absent — nothing to push, don\'t clobber the stored value', async () => {
    rawRef.current = { ...SENT_EVENT_ROW };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: {} } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  it('does NOT re-push on a DRAFT event quote (never sent) even though the date changed', async () => {
    rawRef.current = { ...SENT_EVENT_ROW, quote_sent_at: null, status: null };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  it('does NOT re-push for a NEW quote (the insert branch — no quoteId, isUpdate is false)', async () => {
    const res = await POST(
      makeReq({ serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  it('does NOT re-push for a Test Quote, even with a changed date and a linked contact', async () => {
    rawRef.current = { ...SENT_EVENT_ROW, is_test: true };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  it('does NOT re-push when no HighLevel contact is linked', async () => {
    rawRef.current = { ...SENT_EVENT_ROW, highlevel_contact_id: null };
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  // Positive gate (`=== 'event'`, never `!== 'event'`, per this repo's
  // standing rule): a holiday quote whose stored row happens to carry a
  // leftover event.eventDate (e.g. a service-type switch) must never push.
  it('does NOT re-push for a non-event quote, even with an event.eventDate present in the stored inputs', async () => {
    rawRef.current = { ...SENT_EVENT_ROW, service_type: 'holiday' };
    // Body omits serviceType → effectiveServiceType falls back to the STORED
    // 'holiday' (H2), not 'event'.
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, inputs: { ...validInputs(), event: { eventDate: '2026-12-25' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });

  // FIX D (#237 fix round 2, technical MED — TOCTOU): the regression this
  // whole fix guards. `rawRef.current` (getQuoteRaw's mocked return) stands
  // in for route.ts's EARLY read, taken at the top of the handler — here it
  // still shows the ORIGINAL '2026-12-01', matching what THIS request is
  // about to write back (a staffer who never saw a concurrent edit re-saving
  // the same date they started with). `update`'s mocked return stands in for
  // updateQuote's OWN late pre-read (quotes.ts, `stored.inputs`, taken
  // immediately before its write) — set here to a DIFFERENT date
  // ('2026-12-20'), simulating a second request that landed its own write
  // (and its own GHL push) in the gap between this request's early read and
  // its actual update call. Under the pre-fix logic (compare against
  // `existing.inputs`, i.e. rawRef.current) this would wrongly read as "no
  // change" ('2026-12-01' === '2026-12-01') and skip the push, leaving GHL
  // stuck on '2026-12-20' forever even though the DB now correctly holds
  // '2026-12-01' again. Asserting the push DOES fire, with the date this
  // request is actually writing, proves the compare now uses
  // saved.priorInputs (the late read) instead.
  it('re-pushes when a concurrent write landed between this request\'s early read and its own update (TOCTOU)', async () => {
    rawRef.current = { ...SENT_EVENT_ROW }; // early snapshot: still shows 2026-12-01
    update.mockResolvedValueOnce({
      id: 'existing-id',
      priorInputs: { event: { eventDate: '2026-12-20' } }, // late read: someone else already moved it
    });
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-01' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).toHaveBeenCalledWith('contact_1', '2026-12-01');
  });

  // Counterpart: when updateQuote's late read agrees with the early
  // snapshot (the ordinary case — no concurrent writer), the push still
  // correctly stays silent on a same-value re-save. Guards against a
  // regression that made the new compare fire on EVERY save regardless of
  // an actual change.
  it('still does NOT re-push when the late read agrees with the early snapshot (no concurrent writer)', async () => {
    rawRef.current = { ...SENT_EVENT_ROW }; // 2026-12-01
    update.mockResolvedValueOnce({
      id: 'existing-id',
      priorInputs: { event: { eventDate: '2026-12-01' } }, // late read agrees — no one else touched it
    });
    const res = await POST(
      makeReq({ quoteId: REAL_UUID, serviceType: 'event', inputs: { ...validInputs(), event: { eventDate: '2026-12-01' } } }),
    );
    expect(res.status).toBe(200);
    expect(pushEventDateMock).not.toHaveBeenCalled();
  });
});
