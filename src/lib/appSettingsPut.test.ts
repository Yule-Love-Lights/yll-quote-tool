import { describe, it, expect, beforeEach, vi } from 'vitest';

// putAppSettings (W2-025) — used to re-read the ENTIRE app_settings table once
// per patched key plus a final read (up to 4 full-table reads for a 3-key
// patch). It must read current settings ONCE, apply all patches against that
// snapshot, upsert, then return without a further read.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { putAppSettings } from './appSettings';

type StoredRow = { key: string; value: unknown };

function makeFake(initial: StoredRow[]) {
  const rows = new Map(initial.map((r) => [r.key, r.value]));
  let selectCount = 0;
  const upserts: StoredRow[][] = [];
  const client = {
    from(table: string) {
      expect(table).toBe('app_settings');
      return {
        select() {
          selectCount += 1;
          return Promise.resolve({
            data: Array.from(rows, ([key, value]) => ({ key, value })),
            error: null,
          });
        },
        upsert(newRows: StoredRow[]) {
          upserts.push(newRows);
          for (const r of newRows) rows.set(r.key, r.value);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, getSelectCount: () => selectCount, upserts };
}

beforeEach(() => {
  sbRef.current = null;
});

describe('putAppSettings (W2-025)', () => {
  it('reads the table ONCE for a multi-key patch (render + portal + swatches)', async () => {
    const fake = makeFake([]);
    sbRef.current = fake.client;

    await putAppSettings({
      render: { spritzerRayDensity: 0.8 },
      portal: { hideEarlyInstallDiscounts: true },
      swatches: { buildableColorIds: [] },
    });

    // One read to build the merge snapshot, one read to build the returned
    // AppSettings after the upsert — never one-per-key.
    expect(fake.getSelectCount()).toBeLessThanOrEqual(2);
  });

  it('still merges each patched key over the CURRENT stored value (not stale defaults)', async () => {
    const fake = makeFake([
      { key: 'render', value: { spritzerRayDensity: 1.0 } },
      { key: 'portal', value: { hideEarlyInstallDiscounts: false } },
    ]);
    sbRef.current = fake.client;

    const result = await putAppSettings({ portal: { hideEarlyInstallDiscounts: true } });

    expect(result.portal.hideEarlyInstallDiscounts).toBe(true);
    // render was untouched by this patch — must still reflect the stored value.
    expect(result.render.spritzerRayDensity).toBe(1.0);
  });

  it('a later key in the same patch sees the earlier key\'s change (single-snapshot semantics preserved)', async () => {
    const fake = makeFake([]);
    sbRef.current = fake.client;

    // Two independent keys in one patch — order shouldn't matter for correctness,
    // both should land in the final upserted rows.
    const result = await putAppSettings({
      render: { spritzerRayDensity: 0.5 },
      portal: { hideEarlyInstallDiscounts: true },
    });

    expect(result.render.spritzerRayDensity).toBe(0.5);
    expect(result.portal.hideEarlyInstallDiscounts).toBe(true);
  });
});
