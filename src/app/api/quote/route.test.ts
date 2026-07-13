// Tests for POST /api/quote input validation (audit fix quote-route-validation).
// Proves: (1) a non-UUID quoteId routes to insert (saveQuote) not update; a real
// UUID routes to update. (2) an over-cap array (>500) is a 400. (3) a malformed
// typed element (e.g. a wreath with a bad size) is a clean 400, not a 500.
// The data layer (saveQuote/updateQuote) + designs are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { save, update, getRaw, rawRef, operatorRef } = vi.hoisted(() => ({
  // Typed varargs so `.mock.calls[n]` is an indexable unknown[] (the permanent
  // dispatch tests read positional args like calls[0][3] = serviceType).
  save: vi.fn(async (..._args: unknown[]) => ({ id: 'new-id' })),
  update: vi.fn(async (..._args: unknown[]) => ({ id: 'existing-id' })),
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
    } | null,
  },
  operatorRef: { current: null as { id: string; email: string | null; role: string } | null },
}));

vi.mock('@/lib/quotes', () => ({
  saveQuote: save,
  updateQuote: update,
  getQuoteRaw: getRaw,
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
  getDesignMock.mockResolvedValue(null);
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

  // WT-64: optional maintenance add-on toggle, mirroring the permanent block's
  // maintenanceAddOn boolean validation.
  it('rejects a non-boolean maintenanceAddOn with 400', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { poles: 2, maintenanceAddOn: 'yes' };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a well-formed permanentBistro block with maintenanceAddOn true', async () => {
    const inputs = validInputs();
    inputs.permanentBistro = { bistro: [{ footage: 20 }], maintenanceAddOn: true };
    const res = await POST(makeReq({ serviceType: 'permanent_bistro', inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
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
});

describe('POST /api/quote — created_by actor trail (#90)', () => {
  it('threads the authenticated operator id to saveQuote as created_by', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    // saveQuote(customer, inputs, result, serviceType, isTest, created_by, referredByCustomerId)
    expect(save).toHaveBeenCalledWith(
      expect.anything(), // customer
      expect.anything(), // inputs
      expect.anything(), // result
      expect.anything(), // serviceType
      expect.anything(), // isTest
      'op-1', // created_by
      null, // referredByCustomerId (#41) — not supplied in this request
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
    );
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
