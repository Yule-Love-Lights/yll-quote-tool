import { describe, it, expect, beforeEach, vi } from 'vitest';

// listTrainingExamples (W2-036) — used to fire a SECOND full-table query
// solely to derive the has_analysis boolean. It must now derive has_analysis
// from the one list query.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { listTrainingExamples } from './trainingExamples';

type Row = Record<string, unknown>;

function makeFake(rows: Row[]) {
  let queryCount = 0;
  const seenSelects: string[] = [];
  function from(table: string) {
    expect(table).toBe('training_examples');
    const state = { filters: [] as Array<(r: Row) => boolean> };
    const builder = {
      select(cols: string) {
        queryCount += 1;
        seenSelects.push(cols);
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        state.filters.push((r) => !(val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        const out = rows.filter((r) => state.filters.every((f) => f(r))).slice(0, n);
        return Promise.resolve({ data: out, error: null });
      },
    };
    return builder;
  }
  return { client: { from }, getQueryCount: () => queryCount, getSelects: () => seenSelects };
}

beforeEach(() => {
  sbRef.current = null;
});

describe('listTrainingExamples (W2-036)', () => {
  it('derives has_analysis from a single query (not a second full-table query)', async () => {
    const fake = makeFake([
      { id: 'a', created_at: '2026-01-01', quote_id: 'q1', design_id: 'd1', source: 'manual', excluded: false, notes: null, address: null, street_media_type: 'image/jpeg', street_w: 10, street_h: 10, satellite_media_type: null, satellite_w: null, satellite_h: null, satellite_feet_per_pixel: null, satellite_lines: null, final_inputs: {}, original_analysis: { foo: 'bar' } },
      { id: 'b', created_at: '2026-01-02', quote_id: 'q2', design_id: 'd2', source: 'manual', excluded: false, notes: null, address: null, street_media_type: 'image/jpeg', street_w: 10, street_h: 10, satellite_media_type: null, satellite_w: null, satellite_h: null, satellite_feet_per_pixel: null, satellite_lines: null, final_inputs: {}, original_analysis: null },
    ]);
    sbRef.current = fake.client;

    const out = await listTrainingExamples(200);

    expect(fake.getQueryCount()).toBe(1);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId.a.has_analysis).toBe(true);
    expect(byId.b.has_analysis).toBe(false);
  });

  it('never leaks the heavy original_analysis payload onto list items', async () => {
    const fake = makeFake([
      { id: 'a', created_at: '2026-01-01', quote_id: 'q1', design_id: 'd1', source: 'manual', excluded: false, notes: null, address: null, street_media_type: 'image/jpeg', street_w: 10, street_h: 10, satellite_media_type: null, satellite_w: null, satellite_h: null, satellite_feet_per_pixel: null, satellite_lines: null, final_inputs: {}, original_analysis: { huge: 'payload' } },
    ]);
    sbRef.current = fake.client;

    const out = await listTrainingExamples(200);
    expect(out[0]).not.toHaveProperty('original_analysis');
  });
});
