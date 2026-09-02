// Places the owner marks on the map: hot spots to send the crew to, and
// areas to keep them out of. What these pin: a mark needs a name and a real
// position, a radius is bounded, retiring is a soft retire that keeps the
// record, and the read that feeds the crew's map pages to completeness.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef, logAdvertisingActivity } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: { current: { marks: [] as AnyRow[], seq: 0, insertError: null as { message: string } | null } },
  logAdvertisingActivity: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));

import { createMapMark, listMapMarks, retireMapMark } from './mapMarks';

type Pred = (row: AnyRow) => boolean;

function makeDb() {
  return {
    from(_table: string) {
      return {
        select(_cols?: string) {
          const preds: Pred[] = [];
          const b = {
            eq(col: string, val: unknown) {
              preds.push((r) => r[col] === val);
              return b;
            },
            order() {
              return b;
            },
            range(from: number, to: number) {
              const all = stateRef.current.marks.filter((r) => preds.every((p) => p(r)));
              return Promise.resolve({ data: all.slice(from, to + 1), error: null });
            },
            limit(n: number) {
              const all = stateRef.current.marks.filter((r) => preds.every((p) => p(r)));
              return Promise.resolve({ data: all.slice(0, n), error: null });
            },
          };
          return b;
        },
        insert(payload: AnyRow) {
          if (stateRef.current.insertError) {
            const err = stateRef.current.insertError;
            return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: err }) }) };
          }
          stateRef.current.seq += 1;
          const row = {
            id: `mark-${stateRef.current.seq}`,
            active: true,
            created_at: new Date(2026, 8, stateRef.current.seq).toISOString(),
            note: null,
            radius_m: null,
            ...payload,
          };
          stateRef.current.marks.unshift(row);
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) };
        },
        update(payload: AnyRow) {
          const preds: Pred[] = [];
          const ub = {
            eq(col: string, val: unknown) {
              preds.push((r) => r[col] === val);
              return ub;
            },
            select() {
              return {
                maybeSingle: () => {
                  const hit = stateRef.current.marks.find((r) => preds.every((p) => p(r)));
                  if (!hit) return Promise.resolve({ data: null, error: null });
                  Object.assign(hit, payload);
                  return Promise.resolve({ data: hit, error: null });
                },
              };
            },
          };
          return ub;
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stateRef.current.marks = [];
  stateRef.current.seq = 0;
  stateRef.current.insertError = null;
  dbRef.current = makeDb();
});

const AT = { lat: 40.7259, lng: -73.5143, createdBy: 'admin-1' };

describe('dropping a mark', () => {
  it('records a hot spot with who dropped it, and audits it', async () => {
    const mark = await createMapMark({ kind: 'hotspot', label: 'Route 110 and Conklin', ...AT });

    expect(mark.kind).toBe('hotspot');
    expect(mark.label).toBe('Route 110 and Conklin');
    expect(mark.radiusM).toBeNull(); // a bare point until a radius is given
    expect(mark.active).toBe(true);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-1',
        action: 'map_mark_added',
        detail: expect.objectContaining({ kind: 'hotspot', label: 'Route 110 and Conklin' }),
      }),
    );
  });

  it('records an avoid area with a radius', async () => {
    const mark = await createMapMark({ kind: 'avoid', label: 'Village of Garden City', radiusM: 1200, ...AT });
    expect(mark.kind).toBe('avoid');
    expect(mark.radiusM).toBe(1200);
  });

  it('refuses a mark with no name, because an unlabelled pin tells the crew nothing', async () => {
    await expect(createMapMark({ kind: 'hotspot', label: '   ', ...AT })).rejects.toThrow(/name/i);
    expect(stateRef.current.marks).toHaveLength(0);
  });

  it('refuses a position off the map', async () => {
    await expect(
      createMapMark({ kind: 'hotspot', label: 'nowhere', lat: 91, lng: 0, createdBy: 'admin-1' }),
    ).rejects.toThrow(/off the map/i);
    await expect(
      createMapMark({ kind: 'hotspot', label: 'nowhere', lat: Number.NaN, lng: 0, createdBy: 'admin-1' }),
    ).rejects.toThrow(/position/i);
    expect(stateRef.current.marks).toHaveLength(0);
  });

  it('refuses an unreasonable radius rather than drawing a circle over the county', async () => {
    await expect(
      createMapMark({ kind: 'avoid', label: 'too big', radiusM: 50000, ...AT }),
    ).rejects.toThrow(/radius/i);
    await expect(
      createMapMark({ kind: 'avoid', label: 'fractional', radiusM: 12.5, ...AT }),
    ).rejects.toThrow(/radius/i);
    await expect(createMapMark({ kind: 'avoid', label: 'zero', radiusM: 0, ...AT })).rejects.toThrow(/radius/i);
  });

  it('refuses an unknown kind', async () => {
    await expect(
      createMapMark({ kind: 'maybe' as never, label: 'x', ...AT }),
    ).rejects.toThrow(/kind/i);
  });
});

describe('reading the marks', () => {
  it('lists every mark, newest first', async () => {
    await createMapMark({ kind: 'hotspot', label: 'first', ...AT });
    await createMapMark({ kind: 'avoid', label: 'second', ...AT });

    const all = await listMapMarks();
    expect(all.map((m) => m.label)).toEqual(['second', 'first']);
  });

  it('can be scoped to what the crew should currently see', async () => {
    const a = await createMapMark({ kind: 'hotspot', label: 'still good', ...AT });
    const b = await createMapMark({ kind: 'hotspot', label: 'stopped working', ...AT });
    await retireMapMark(b.id, 'admin-1');

    const live = await listMapMarks({ activeOnly: true });
    expect(live.map((m) => m.label)).toEqual(['still good']);
    expect(live.map((m) => m.id)).toEqual([a.id]);

    // and the retired one is still on the books
    expect((await listMapMarks()).map((m) => m.label)).toEqual(['stopped working', 'still good']);
  });
});

describe('retiring a mark', () => {
  it('stops showing it without destroying the record that it was tried', async () => {
    const mark = await createMapMark({ kind: 'hotspot', label: 'was worth a try', ...AT });

    const retired = await retireMapMark(mark.id, 'admin-2');
    expect(retired.active).toBe(false);
    expect(stateRef.current.marks).toHaveLength(1); // nothing deleted
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'admin-2', action: 'map_mark_retired' }),
    );
  });

  it('is idempotent, so a second tap is not an error on a done thing', async () => {
    const mark = await createMapMark({ kind: 'hotspot', label: 'gone', ...AT });
    await retireMapMark(mark.id, 'admin-1');

    const again = await retireMapMark(mark.id, 'admin-2');
    expect(again.active).toBe(false);

    // The second call changed nothing, so it must not claim a retirement in
    // the trail that never happened.
    const retires = logAdvertisingActivity.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'map_mark_retired',
    );
    expect(retires).toHaveLength(1);
  });

  it('refuses a mark that does not exist', async () => {
    await expect(retireMapMark('no-such-id', 'admin-1')).rejects.toThrow(/no mark found/i);
  });
});
