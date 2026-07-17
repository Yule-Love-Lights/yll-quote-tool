// #160: getJobWorkOrder must narrow a holiday job's materials to the customer's
// APPROVED selection (approval_snapshot.customerSelection.selectedItemIds)
// instead of the full scene — a partial-selection job (e.g. a spritzer priced
// but never selected before paying) must not order materials for items the
// customer never bought. Mirrors jobsWorkOrderPermanent.test.ts's DB-mocking
// shape. projectMaterials is mocked to a FIXED set of lines tagged with known
// sceneItemIds so this file isolates getJobWorkOrder's WIRING of the filter —
// selectedSceneItemIds itself (the real, unmocked resolver) is unit-tested
// directly in jobs.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { applyProjectionToInputs } from '@/lib/design/projectScene';
import type { Scene, StrandItem, SpritzerItem } from '@/lib/design/sceneTypes';

let currentDb: unknown = null;
let jobRow: Record<string, unknown> | null = null;
let quoteRow: Record<string, unknown> | null = null;
let designScene: Scene | null = null;

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('../jobs', () => ({
  getJob: vi.fn(async () => jobRow),
  listJobs: vi.fn(async () => []),
}));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })) }));
vi.mock('./catalog', () => ({
  listCatalog: vi.fn(async () => []),
  catalogCostOverrides: vi.fn(async () => new Map()),
}));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []), upsertOnHand: vi.fn(async () => {}) }));

const { projectMaterials } = vi.hoisted(() => ({ projectMaterials: vi.fn() }));
vi.mock('./materialsProjection', () => ({
  projectMaterials,
  buildMaterialsView: vi.fn((lines: { sku: string | null; qty: number }[]) => ({
    materials: lines
      .filter((l) => l.sku)
      .map((l) => ({ sku: l.sku, name: '(not in catalog)', qty: l.qty, onHand: null, short: false })),
    unbound: [],
    totalLines: lines.length,
  })),
}));

import { getJobWorkOrder } from './jobs';

function makeDb() {
  return {
    from(table: string) {
      const b = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        async maybeSingle() {
          if (table === 'jobs') return { data: { stock_decremented_at: null }, error: null };
          if (table === 'designs') return { data: { scene: designScene }, error: null };
          if (table === 'quotes') return { data: quoteRow, error: null };
          return { data: null, error: null };
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectMaterials.mockReset();
  currentDb = makeDb();
  jobRow = {
    id: 'j1',
    job_number: 1000,
    quote_id: 'q1',
    design_id: 'd1',
    fulfillment_stage: 'to_be_prepared',
    status: 'to_schedule',
    install_date: null,
    line_items: [],
  };
});

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

// A real scene, run through the actual projection + pricing engine, so the
// line-item ids/labels/stableIds attachSceneLinks matches against are exactly
// what a live quote would produce (not hand-guessed).
const scene: Scene = { yardsticks: [], items: [bushStrand('bush1'), spritzerItem('spritzer1')] };
const inputs = applyProjectionToInputs(baseInputs(), scene);
const result = calculateQuote(inputs);

// The FIXED "projected materials" — one line per scene item, tagged with its
// sceneItemId (the real contract MaterialLine carries). getJobWorkOrder's own
// holiday/event bindings + colorChoice never factor into which lines are
// returned here — only the selection filter, which is what this file tests.
const FIXED_LINES = [
  { sku: 'BUSH-SKU', qty: 2, category: 'mini', conceptKey: 'mini:bush', label: 'Bush', sceneItemId: 'bush1' },
  { sku: 'SPRITZER-SKU', qty: 1, category: 'spritzer', conceptKey: 'spritzer:24', label: 'Spritzer', sceneItemId: 'spritzer1' },
];

const rooflineScene: Scene = {
  yardsticks: [],
  items: [rooflineStrand('front1', 'santas-roofline'), rooflineStrand('ridge1', 'gingerbread')],
};
const rooflineInputs = baseInputs({ santasFootage: 100, gingerbreadFootage: 50, rooflineChoice: 'santas' });
const rooflineResult = calculateQuote(rooflineInputs);
const ROOFLINE_LINES = [
  { sku: 'C9-FRONT-SKU', qty: 10, category: 'bulb', conceptKey: 'bulb:front', label: 'Front bulbs', sceneItemId: 'front1' },
  { sku: 'C9-RIDGE-SKU', qty: 6, category: 'bulb', conceptKey: 'bulb:ridge', label: 'Ridge bulbs', sceneItemId: 'ridge1' },
];

describe('getJobWorkOrder — #160 holiday materials respect the approved selection', () => {
  it('(a) excludes the unselected spritzer while keeping the selected bush', async () => {
    designScene = scene;
    projectMaterials.mockReturnValueOnce(FIXED_LINES);
    quoteRow = {
      customer_name: 'Partial Customer',
      customer_address: '1 Partial St',
      is_test: false,
      approval_snapshot: { customerSelection: { selectedItemIds: ['bush-1'] } },
      service_type: 'holiday',
      inputs,
      result,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('BUSH-SKU');
    expect(skus).not.toContain('SPRITZER-SKU');
  });

  it('(b) no approval snapshot → both materials present (unchanged behavior)', async () => {
    designScene = scene;
    projectMaterials.mockReturnValueOnce(FIXED_LINES);
    quoteRow = {
      customer_name: 'No Snapshot Customer',
      customer_address: '1 Unsent St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'holiday',
      inputs,
      result,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('BUSH-SKU');
    expect(skus).toContain('SPRITZER-SKU');
  });

  it('a staff-approved-everything selection (every real id) → both materials present', async () => {
    designScene = scene;
    projectMaterials.mockReturnValueOnce(FIXED_LINES);
    quoteRow = {
      customer_name: 'Staff Approved Customer',
      customer_address: '1 Staff St',
      is_test: false,
      approval_snapshot: { customerSelection: { selectedItemIds: ['bush-1', 'spritzer-1'] } },
      service_type: 'holiday',
      inputs,
      result,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('BUSH-SKU');
    expect(skus).toContain('SPRITZER-SKU');
  });

  it('(c) empty selectedItemIds (unresolvable) → fail open, both materials present', async () => {
    designScene = scene;
    projectMaterials.mockReturnValueOnce(FIXED_LINES);
    quoteRow = {
      customer_name: 'Empty Selection Customer',
      customer_address: '1 Empty St',
      is_test: false,
      approval_snapshot: { customerSelection: { selectedItemIds: [] } },
      service_type: 'holiday',
      inputs,
      result,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('BUSH-SKU');
    expect(skus).toContain('SPRITZER-SKU');
  });

  it("(d) mutually-exclusive roofline: selecting Santa's excludes the ridge-only materials", async () => {
    designScene = rooflineScene;
    projectMaterials.mockReturnValueOnce(ROOFLINE_LINES);
    quoteRow = {
      customer_name: 'Roofline Customer',
      customer_address: '1 Roofline St',
      is_test: false,
      approval_snapshot: { customerSelection: { selectedItemIds: ['roofline-santas'] } },
      service_type: 'holiday',
      inputs: rooflineInputs,
      result: rooflineResult,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('C9-FRONT-SKU');
    expect(skus).not.toContain('C9-RIDGE-SKU');
  });
});
