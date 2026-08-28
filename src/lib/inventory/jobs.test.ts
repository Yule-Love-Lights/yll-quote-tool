import { describe, it, expect, vi } from 'vitest';
import {
  isActiveFulfillment,
  groupByStage,
  computeStockDeductions,
  selectedSceneItemIds,
  listFulfillmentCards,
  PENDING_STOCK_SNAPSHOT,
  type FulfillmentCard,
} from './jobs';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { applyProjectionToInputs } from '@/lib/design/projectScene';
import type { Scene, StrandItem, SpritzerItem, GarlandItem } from '@/lib/design/sceneTypes';

// Row 382: listFulfillmentCards needs a real DB — mocked only for the
// describe block below that exercises it. Every OTHER test in this file
// tests pure functions and never touches supabase, so this mock is inert for
// them (vi.mock is file-scoped and hoisted, but currentDb starts null and is
// only ever set inside the block that needs it).
let currentDb: unknown = null;
let billingJobs: Record<string, unknown>[] = [];
vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('../jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs')>();
  return { ...actual, listJobs: vi.fn(async () => billingJobs) };
});

const card = (over: Partial<FulfillmentCard>): FulfillmentCard => ({
  id: 'j1',
  jobNumber: 1000,
  quoteId: 'q1',
  designId: null,
  stage: 'to_be_ordered',
  status: 'to_schedule',
  customerName: 'A',
  customerAddress: '1 St',
  itemCount: 0,
  installDate: null,
  isTest: false,
  highlevelContactId: null,
  customerId: null,
  stockSnapshotPending: false,
  ...over,
});

describe('isActiveFulfillment', () => {
  it('is active only pre-install (to_schedule / scheduled)', () => {
    expect(isActiveFulfillment('to_schedule')).toBe(true);
    expect(isActiveFulfillment('scheduled')).toBe(true);
    expect(isActiveFulfillment('installed')).toBe(false);
    expect(isActiveFulfillment('requires_invoicing')).toBe(false);
    expect(isActiveFulfillment('done')).toBe(false);
    expect(isActiveFulfillment('cancelled')).toBe(false);
  });
});

describe('groupByStage', () => {
  it('buckets cards into all four columns (empty columns present, order stable)', () => {
    const g = groupByStage([
      card({ id: 'a', stage: 'to_be_ordered' }),
      card({ id: 'b', stage: 'ready_for_install' }),
      card({ id: 'c', stage: 'to_be_ordered' }),
    ]);
    expect(Object.keys(g)).toEqual([
      'to_be_ordered',
      'awaiting_pickup',
      'to_be_prepared',
      'ready_for_install',
    ]);
    expect(g.to_be_ordered.map((c) => c.id)).toEqual(['a', 'c']);
    expect(g.awaiting_pickup).toEqual([]);
    expect(g.ready_for_install.map((c) => c.id)).toEqual(['b']);
  });
});

describe('computeStockDeductions (#82 Phase 2)', () => {
  it('deducts tracked SKUs, floors at 0, skips untracked + zero-need', () => {
    expect(
      computeStockDeductions([
        { sku: 'A', qty: 3, onHand: 10 }, // → 7
        { sku: 'B', qty: 8, onHand: 5 }, // → floors at 0 (deducted 5, not 8)
        { sku: 'C', qty: 2, onHand: null }, // untracked → skip
        { sku: 'D', qty: 0, onHand: 4 }, // zero need → skip
        { sku: 'E', qty: 4, onHand: 0 }, // nothing on hand → no change → skip
      ]),
    ).toEqual([
      { sku: 'A', before: 10, deducted: 3, after: 7 },
      { sku: 'B', before: 5, deducted: 5, after: 0 },
    ]);
  });
});

// ── selectedSceneItemIds (#160 — BOM respects the approved selection) ────────

function baseInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...overrides,
  };
}

function bushStrand(id: string): StrandItem {
  return {
    id,
    yardstickId: null,
    kind: 'strand',
    bulbType: 'mini',
    spacingIn: 6,
    drawingStyle: 'strand',
    colorPattern: ['warm-white'],
    points: [0, 0, 10, 0],
    surface: 'bush',
    included: true,
    stringCount: 2,
  };
}

function spritzerItem(id: string): SpritzerItem {
  return {
    id,
    yardstickId: null,
    kind: 'spritzer',
    x: 0,
    y: 0,
    sizeIn: 24,
    colorPattern: ['warm-white'],
    quoteSize: '24',
    included: true,
  };
}

function garlandItem(id: string): GarlandItem {
  return {
    id,
    yardstickId: null,
    kind: 'garland',
    points: [0, 0, 5, 0],
    drawingStyle: 'strand',
    withLights: true,
    included: true,
    quoteLength: '9ft',
    quoteSections: 1,
    tier: 'bow',
  };
}

function rooflineStrand(id: string, surface: 'santas-roofline' | 'gingerbread'): StrandItem {
  return {
    id,
    yardstickId: null,
    kind: 'strand',
    bulbType: 'c9',
    spacingIn: 12,
    drawingStyle: 'strand',
    colorPattern: ['warm-white'],
    points: [0, 0, 20, 0],
    surface,
    included: true,
  };
}

// A real scene (bush + spritzer) run through the actual projection + pricing
// engine, so the line-item ids/labels/stableIds are exactly what a live quote
// would produce (not hand-guessed). `liveScene` additionally carries a THIRD
// item (a garland) that was NEVER priced — simulating a design edited after the
// last Calculate — to exercise the fail-open guarantee.
const pricedItems = [bushStrand('bush1'), spritzerItem('spritzer1')];
const pricedScene: Scene = { yardsticks: [], items: pricedItems };
const projectedInputs = applyProjectionToInputs(baseInputs(), pricedScene);
const result = calculateQuote(projectedInputs);
const liveScene: Scene = { yardsticks: [], items: [...pricedItems, garlandItem('garland1')] };

describe('selectedSceneItemIds — (a) excludes an unselected item, fails open on an unlinked one', () => {
  it('keeps the selected bush, drops the unselected spritzer, keeps the never-priced garland', () => {
    const snapshot = { customerSelection: { selectedItemIds: ['bush-1'] } };
    const keep = selectedSceneItemIds(liveScene, result, projectedInputs, snapshot);
    expect(keep).not.toBeNull();
    expect(keep!.has('bush1')).toBe(true);
    expect(keep!.has('spritzer1')).toBe(false);
    // garland1 has no corresponding line item at all (predates the last
    // Calculate) — we can't tell if it was "selected", so it stays IN.
    expect(keep!.has('garland1')).toBe(true);
  });
});

describe('selectedSceneItemIds — (b) no snapshot → null (unfiltered, unchanged behavior)', () => {
  it('returns null for a missing / empty / no-customerSelection snapshot', () => {
    expect(selectedSceneItemIds(pricedScene, result, projectedInputs, null)).toBeNull();
    expect(selectedSceneItemIds(pricedScene, result, projectedInputs, undefined)).toBeNull();
    expect(selectedSceneItemIds(pricedScene, result, projectedInputs, {})).toBeNull();
  });
});

describe('selectedSceneItemIds — (c) unresolvable / empty selection → null (fail open)', () => {
  it('returns null when selectedItemIds is empty', () => {
    const snapshot = { customerSelection: { selectedItemIds: [] } };
    expect(selectedSceneItemIds(pricedScene, result, projectedInputs, snapshot)).toBeNull();
  });

  it('returns null when selectedItemIds are all unknown/stale ids', () => {
    const snapshot = { customerSelection: { selectedItemIds: ['does-not-exist'] } };
    expect(selectedSceneItemIds(pricedScene, result, projectedInputs, snapshot)).toBeNull();
  });

  it('returns null when there is no saved pricing result to rebuild line items from', () => {
    const snapshot = { customerSelection: { selectedItemIds: ['bush-1'] } };
    expect(selectedSceneItemIds(pricedScene, null, projectedInputs, snapshot)).toBeNull();
  });
});

describe('selectedSceneItemIds — (d) mutually-exclusive roofline', () => {
  const rooflineScene: Scene = {
    yardsticks: [],
    items: [rooflineStrand('front1', 'santas-roofline'), rooflineStrand('ridge1', 'gingerbread')],
  };
  const rooflineInputs = baseInputs({ santasFootage: 100, gingerbreadFootage: 50, rooflineChoice: 'santas' });
  const rooflineResult = calculateQuote(rooflineInputs);

  it("selecting Santa's only keeps the front strand, drops the ridge-only strand", () => {
    const snapshot = { customerSelection: { selectedItemIds: ['roofline-santas'] } };
    const keep = selectedSceneItemIds(rooflineScene, rooflineResult, rooflineInputs, snapshot);
    expect(keep!.has('front1')).toBe(true);
    expect(keep!.has('ridge1')).toBe(false);
  });

  it('selecting Gingerbread (the superset, even though NOT the recommended/billed option) keeps both', () => {
    const snapshot = { customerSelection: { selectedItemIds: ['roofline-gingerbread'] } };
    const keep = selectedSceneItemIds(rooflineScene, rooflineResult, rooflineInputs, snapshot);
    expect(keep!.has('front1')).toBe(true);
    expect(keep!.has('ridge1')).toBe(true);
  });
});

// Row 382: nothing enumerated a job stuck at PENDING_STOCK_SNAPSHOT before —
// this proves listFulfillmentCards actually computes the flag the digest
// (prepDigest.test.ts) relies on, from a live-shaped DB read.
describe('listFulfillmentCards — stockSnapshotPending (row 382)', () => {
  function makeDb(stockRows: { id: string; stock_deductions: unknown }[]) {
    return {
      from(table: string) {
        return {
          select: () => ({
            in: async () => {
              if (table === 'quotes') return { data: [] };
              if (table === 'jobs') return { data: stockRows };
              return { data: [] };
            },
          }),
        };
      },
    };
  }

  it('flags a card whose stock_deductions is the PENDING sentinel', async () => {
    billingJobs = [
      { id: 'j1', job_number: 1, quote_id: null, design_id: null, fulfillment_stage: 'ready_for_install', status: 'to_schedule', line_items: [], install_date: null, customer_id: null },
    ];
    currentDb = makeDb([{ id: 'j1', stock_deductions: PENDING_STOCK_SNAPSHOT }]);
    const cards = await listFulfillmentCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].stockSnapshotPending).toBe(true);
  });

  it('does NOT flag a card with a real snapshot array, or with null (never prepped / true legacy)', async () => {
    billingJobs = [
      { id: 'j1', job_number: 1, quote_id: null, design_id: null, fulfillment_stage: 'ready_for_install', status: 'to_schedule', line_items: [], install_date: null, customer_id: null },
      { id: 'j2', job_number: 2, quote_id: null, design_id: null, fulfillment_stage: 'to_be_ordered', status: 'to_schedule', line_items: [], install_date: null, customer_id: null },
    ];
    currentDb = makeDb([
      { id: 'j1', stock_deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }] },
      { id: 'j2', stock_deductions: null },
    ]);
    const cards = await listFulfillmentCards();
    expect(cards.find((c) => c.id === 'j1')?.stockSnapshotPending).toBe(false);
    expect(cards.find((c) => c.id === 'j2')?.stockSnapshotPending).toBe(false);
  });
});
