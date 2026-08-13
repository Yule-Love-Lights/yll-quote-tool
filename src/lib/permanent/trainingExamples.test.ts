import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks for capturePermanentTrainingExample's dependencies (quote lookup,
// design lookup, photo download, embedding) so the assembly logic can be
// exercised without a real Supabase/storage/Voyage round-trip. Mirrors
// src/lib/trainingExamples.test.ts's W5-030 mock pattern.
const { sbRef, quoteRef, designRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  quoteRef: { current: null as unknown },
  designRef: { current: null as unknown },
}));
vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));
vi.mock('../quotes', () => ({ getQuoteRaw: async () => quoteRef.current }));
vi.mock('../designs', () => ({
  getDesign: async () => designRef.current,
  downloadDesignImageBase64: async (path: string | null) =>
    path ? { base64: 'AAAA', mediaType: 'image/jpeg' } : null,
}));
vi.mock('../embeddings', () => ({ embedImage: async () => null }));

import {
  capturePermanentTrainingExample,
  extractFinalStreetRuns,
  getRecentPermanentTrainingExamples,
  getSimilarPermanentTrainingExamples,
  listPermanentTrainingExamples,
} from './trainingExamples';
import type { Scene } from '../design/sceneTypes';

function makeCaptureSb() {
  let upsertedRow: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => ({ data: { id: 'design-1' }, error: null });
  builder.upsert = (row: Record<string, unknown>) => {
    upsertedRow = row;
    return builder;
  };
  builder.single = async () => ({ data: { id: 'ex-1' }, error: null });
  const client = { from: () => builder };
  return { client, getUpsertedRow: () => upsertedRow };
}

const STREET_SCENE: Scene = {
  yardsticks: [],
  items: [
    // Street-visible permanent run — kept.
    {
      id: 's1', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [100, 100, 600, 100],
      sideOfHouse: 'front', included: true,
    },
    // Back never shows from the street — dropped.
    {
      id: 's2', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 500, 0],
      sideOfHouse: 'back', included: true,
    },
    // Wrong bulb type — dropped (this library only teaches permanent runs).
    {
      id: 's3', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 100, 0],
      sideOfHouse: 'left', included: true,
    },
    // A render-only twin — dropped (not a new run).
    {
      id: 's4', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [200, 200, 400, 400],
      sideOfHouse: 'left', included: true, linkedToId: 's1',
    },
  ],
};

// #249 review fix (provenance): separate fixture so STREET_SCENE's exact-match
// assertion above stays untouched. Covers the three sideOfHouseAuto states a
// strand can be in by the time a quote sends.
const PROVENANCE_SCENE: Scene = {
  yardsticks: [],
  items: [
    // Sticky pre-draw quick-tag default, never touched by a human — dropped.
    {
      id: 'p1', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 100, 0],
      sideOfHouse: 'front', sideOfHouseAuto: true, included: true,
    },
    // No auto flag at all (legacy shape / drawn before #249) — kept, same as STREET_SCENE's s1.
    {
      id: 'p2', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 100, 0],
      sideOfHouse: 'left', included: true,
    },
    // Auto tag later confirmed/overwritten via the #sel-side-of-house dropdown
    // (which clears the flag to false) — kept.
    {
      id: 'p3', yardstickId: null, kind: 'strand', bulbType: 'permanent', spacingIn: 8,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 100, 0],
      sideOfHouse: 'right', sideOfHouseAuto: false, included: true,
    },
  ],
};

describe('extractFinalStreetRuns', () => {
  it('keeps only street-visible (front/left/right) permanent, non-twin strands, normalized to 0-1', () => {
    const runs = extractFinalStreetRuns(STREET_SCENE, 1000, 500);
    expect(runs).toEqual([{ side: 'front', points: [[0.1, 0.2], [0.6, 0.2]], label: '' }]);
  });

  it('returns [] when photo dims are missing or zero', () => {
    expect(extractFinalStreetRuns(STREET_SCENE, 0, 500)).toEqual([]);
    expect(extractFinalStreetRuns(STREET_SCENE, 1000, null)).toEqual([]);
    expect(extractFinalStreetRuns(null, 1000, 500)).toEqual([]);
  });

  it('excludes an unconfirmed sticky pre-draw tag (sideOfHouseAuto) from training ground truth, but keeps manual and dropdown-confirmed tags', () => {
    const runs = extractFinalStreetRuns(PROVENANCE_SCENE, 1000, 500);
    expect(runs.map((r) => r.side)).toEqual(['left', 'right']);
  });
});

describe('capturePermanentTrainingExample', () => {
  beforeEach(() => {
    quoteRef.current = null;
    designRef.current = null;
    sbRef.current = null;
  });

  it('positive gate: refuses a non-permanent quote', async () => {
    quoteRef.current = { id: 'q1', customer_address: '1 Main', service_type: 'holiday', inputs: {} };
    sbRef.current = makeCaptureSb().client;
    const res = await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });
    expect(res).toEqual({ error: 'Not a permanent quote' });
  });

  it('refuses when the design has no confirmed satellite lines yet', async () => {
    quoteRef.current = { id: 'q1', customer_address: '1 Main', service_type: 'permanent', inputs: {} };
    designRef.current = {
      id: 'design-1', scene: { yardsticks: [], items: [] },
      photo_path: null, photo_w: null, photo_h: null,
      satellite_path: 'sat.jpg', satellite_lines: null,
    };
    sbRef.current = makeCaptureSb().client;
    const res = await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });
    expect(res).toEqual({ error: 'Design has no confirmed satellite lines yet — nothing to capture' });
  });

  it('refuses when there are confirmed lines but no satellite image to snapshot', async () => {
    quoteRef.current = { id: 'q1', customer_address: '1 Main', service_type: 'permanent', inputs: {} };
    designRef.current = {
      id: 'design-1', scene: { yardsticks: [], items: [] },
      photo_path: null, photo_w: null, photo_h: null,
      satellite_path: null, // no image to download
      satellite_lines: { front: [{ points: [[0, 0], [1, 1]], label: 'x' }], left: [], right: [], back: [] },
    };
    sbRef.current = makeCaptureSb().client;
    const res = await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });
    expect(res).toEqual({ error: 'Design has no satellite image — an example needs the satellite photo' });
  });

  it('assembles a full example: satellite lines, street runs, sanitized inputs, jumps provenance', async () => {
    quoteRef.current = {
      id: 'q1',
      customer_address: '1 Main',
      service_type: 'permanent',
      inputs: {
        permanent: {
          frontFootage: 40, leftFootage: -5, rightFootage: 30, backFootage: 0,
          frontCorners: 3, leftCorners: 0, rightCorners: 3, backCorners: 0,
          extensions: { e3: 1, e5: 2, e10: 0, e25: 0 }, splittersNeeded: 1,
        },
      },
    };
    designRef.current = {
      id: 'design-1',
      scene: STREET_SCENE,
      photo_path: 'p.jpg', photo_w: 1000, photo_h: 500,
      satellite_path: 'sat.jpg', satellite_feet_per_pixel: 0.2,
      satellite_lines: { front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front' }], left: [], right: [], back: [] },
      seed_analysis: { jumps: [{ ft: 12, splitter: true, label: 'porch to second story' }] },
    };
    const { client, getUpsertedRow } = makeCaptureSb();
    sbRef.current = client;

    const res = await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });

    expect(res).toEqual({ id: 'ex-1' });
    const row = getUpsertedRow()!;
    expect(row.final_satellite_lines).toEqual({
      front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front' }], left: [], right: [], back: [],
    });
    expect(row.final_street_runs).toEqual([{ side: 'front', points: [[0.1, 0.2], [0.6, 0.2]], label: '' }]);
    expect(row.satellite_photo_base64).toBe('AAAA');
    expect(row.street_photo_base64).toBe('AAAA');
    expect(row.original_analysis).toEqual({ jumps: [{ ft: 12, splitter: true, label: 'porch to second story' }] });
    const finalInputs = row.final_inputs as Record<string, unknown>;
    expect(finalInputs.leftFootage).toBe(0); // sanitized from -5
    expect(finalInputs.frontFootage).toBe(40);
    expect(finalInputs.extensions).toEqual({ e3: 1, e5: 2, e10: 0, e25: 0 });
    expect(finalInputs.splittersNeeded).toBe(1);
  });

  it('final_inputs is null when the quote has no permanent inputs block', async () => {
    quoteRef.current = { id: 'q1', customer_address: '1 Main', service_type: 'permanent', inputs: {} };
    designRef.current = {
      id: 'design-1', scene: { yardsticks: [], items: [] },
      photo_path: null, photo_w: null, photo_h: null,
      satellite_path: 'sat.jpg',
      satellite_lines: { front: [{ points: [[0, 0], [1, 1]], label: 'x' }], left: [], right: [], back: [] },
    };
    const { client, getUpsertedRow } = makeCaptureSb();
    sbRef.current = client;

    await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });
    expect(getUpsertedRow()!.final_inputs).toBeNull();
  });

  it('fails open (returns an error, never throws) when the upsert errors — e.g. the table not created yet', async () => {
    quoteRef.current = { id: 'q1', customer_address: '1 Main', service_type: 'permanent', inputs: {} };
    designRef.current = {
      id: 'design-1', scene: { yardsticks: [], items: [] },
      photo_path: null, photo_w: null, photo_h: null,
      satellite_path: 'sat.jpg',
      satellite_lines: { front: [{ points: [[0, 0], [1, 1]], label: 'x' }], left: [], right: [], back: [] },
    };
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = async () => ({ data: { id: 'design-1' }, error: null });
    builder.upsert = () => builder;
    builder.single = async () => ({
      data: null,
      error: { message: 'relation "permanent_training_examples" does not exist', code: '42P01' },
    });
    sbRef.current = { from: () => builder };

    const res = await capturePermanentTrainingExample({ quoteId: 'q1', source: 'manual' });
    expect(res).toEqual({ error: 'Failed to save the training example' });
  });
});

describe('retrieval + list fail-open (missing table / unconfigured Supabase)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('getRecentPermanentTrainingExamples returns [] on a query error', async () => {
    sbRef.current = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'relation does not exist' } }) }) }) }),
      }),
    };
    expect(await getRecentPermanentTrainingExamples()).toEqual([]);
  });

  it('getSimilarPermanentTrainingExamples returns [] when the RPC errors', async () => {
    sbRef.current = { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) };
    expect(await getSimilarPermanentTrainingExamples([1, 2, 3])).toEqual([]);
  });

  it('every retrieval/list function returns null/[] when Supabase is not configured at all', async () => {
    sbRef.current = null;
    expect(await getRecentPermanentTrainingExamples()).toEqual([]);
    expect(await getSimilarPermanentTrainingExamples([1])).toEqual([]);
    expect(await listPermanentTrainingExamples()).toEqual([]);
  });
});
