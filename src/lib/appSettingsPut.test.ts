import { describe, it, expect, beforeEach, vi } from 'vitest';

// putAppSettings (W2-025) — used to re-read the ENTIRE app_settings table once
// per patched key plus a final read (up to 4 full-table reads for a 3-key
// patch). It must read current settings ONCE, apply all patches against that
// snapshot, upsert, then return without a further read.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { putAppSettings } from './appSettings';
import { DEFAULT_PERMANENT_WARRANTY } from './permanent/types';
import { DEFAULT_HOLIDAY_WARRANTY, DEFAULT_EVENT_WARRANTY, DEFAULT_BISTRO_WARRANTY } from './warranty/types';

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

  it('permanentSwatches is stored under its OWN key, independent of holiday swatches (#88 P6b-4)', async () => {
    const fake = makeFake([]);
    sbRef.current = fake.client;

    const result = await putAppSettings({
      permanentSwatches: {
        schemes: [
          { id: 'as-designed', label: 'As Designed', colorIds: null },
          { id: 'blue', label: 'Blue', colorIds: ['blue'] },
        ],
        buildableColorIds: ['red', 'blue'],
      },
    });

    // Stored under permanentSwatches, NOT swatches.
    expect(result.permanentSwatches.schemes.map((s) => s.id)).toContain('blue');
    expect(fake.upserts.flat().some((r) => r.key === 'permanentSwatches')).toBe(true);
    expect(fake.upserts.flat().some((r) => r.key === 'swatches')).toBe(false);
    // Holiday swatches untouched → still the factory default.
    expect(result.swatches.schemes.length).toBeGreaterThan(0);
  });
});

describe('putAppSettings — permanentWarranty version bump (#88 P6b-2)', () => {
  it('bumps the version by 1 when the copy changes', async () => {
    const fake = makeFake([]); // unconfigured → default (version 1)
    sbRef.current = fake.client;

    const result = await putAppSettings({ permanentWarranty: { heading: 'Rock solid.' } });

    expect(result.permanentWarranty.heading).toBe('Rock solid.');
    expect(result.permanentWarranty.version).toBe(DEFAULT_PERMANENT_WARRANTY.version + 1); // 2
  });

  it('does NOT bump when the saved copy is byte-identical to the current copy', async () => {
    const fake = makeFake([
      { key: 'permanentWarranty', value: { ...DEFAULT_PERMANENT_WARRANTY, version: 5 } },
    ]);
    sbRef.current = fake.client;

    const result = await putAppSettings({
      permanentWarranty: {
        eyebrow: DEFAULT_PERMANENT_WARRANTY.eyebrow,
        heading: DEFAULT_PERMANENT_WARRANTY.heading,
        bullets: DEFAULT_PERMANENT_WARRANTY.bullets,
      },
    });

    expect(result.permanentWarranty.version).toBe(5); // no copy change → no bump
  });

  it('ignores a client-supplied version (server-authoritative — no copy change → no bump)', async () => {
    const fake = makeFake([
      { key: 'permanentWarranty', value: { ...DEFAULT_PERMANENT_WARRANTY, version: 3 } },
    ]);
    sbRef.current = fake.client;

    // A client tries to force version 99 with no actual copy change.
    const result = await putAppSettings({
      permanentWarranty: { version: 99 } as never,
    });

    expect(result.permanentWarranty.version).toBe(3); // forged version discarded
  });

  it('bumps once per distinct edit across sequential saves', async () => {
    const fake = makeFake([
      { key: 'permanentWarranty', value: { ...DEFAULT_PERMANENT_WARRANTY, version: 2 } },
    ]);
    sbRef.current = fake.client;

    const r1 = await putAppSettings({ permanentWarranty: { eyebrow: 'Guarantee' } });
    expect(r1.permanentWarranty.version).toBe(3);

    const r2 = await putAppSettings({ permanentWarranty: { eyebrow: 'Our Guarantee' } });
    expect(r2.permanentWarranty.version).toBe(4);
  });
});

// WT-56/65/07 — the same version-bump mechanism, generalized to the other three
// verticals, each stored under its OWN key and independently versioned.
describe('putAppSettings — holiday/event/bistro warranty version bump (WT-56/65/07)', () => {
  it('bumps holidayWarranty version by 1 when the copy changes, independent of the other keys', async () => {
    const fake = makeFake([]); // unconfigured → defaults (all version 1)
    sbRef.current = fake.client;

    const result = await putAppSettings({ holidayWarranty: { heading: 'Rock solid.' } });

    expect(result.holidayWarranty.heading).toBe('Rock solid.');
    expect(result.holidayWarranty.version).toBe(DEFAULT_HOLIDAY_WARRANTY.version + 1); // 2
    // The other three verticals are untouched by this patch.
    expect(result.eventWarranty.version).toBe(DEFAULT_EVENT_WARRANTY.version);
    expect(result.bistroWarranty.version).toBe(DEFAULT_BISTRO_WARRANTY.version);
    expect(result.permanentWarranty.version).toBe(DEFAULT_PERMANENT_WARRANTY.version);
    expect(fake.upserts.flat().some((r) => r.key === 'holidayWarranty')).toBe(true);
    expect(fake.upserts.flat().some((r) => r.key === 'eventWarranty')).toBe(false);
  });

  it('does NOT bump eventWarranty when the saved copy is byte-identical to the current copy', async () => {
    const fake = makeFake([
      { key: 'eventWarranty', value: { ...DEFAULT_EVENT_WARRANTY, version: 5 } },
    ]);
    sbRef.current = fake.client;

    const result = await putAppSettings({
      eventWarranty: {
        eyebrow: DEFAULT_EVENT_WARRANTY.eyebrow,
        heading: DEFAULT_EVENT_WARRANTY.heading,
        bullets: DEFAULT_EVENT_WARRANTY.bullets,
      },
    });

    expect(result.eventWarranty.version).toBe(5); // no copy change → no bump
  });

  it('ignores a client-supplied version on bistroWarranty (server-authoritative)', async () => {
    const fake = makeFake([
      { key: 'bistroWarranty', value: { ...DEFAULT_BISTRO_WARRANTY, version: 3 } },
    ]);
    sbRef.current = fake.client;

    const result = await putAppSettings({ bistroWarranty: { version: 99 } as never });

    expect(result.bistroWarranty.version).toBe(3); // forged version discarded
  });

  it('caps bistroWarranty bullets at 4 slots (its fixed icon count, not permanent’s 6)', async () => {
    const fake = makeFake([]);
    sbRef.current = fake.client;

    const result = await putAppSettings({
      bistroWarranty: { bullets: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });

    expect(result.bistroWarranty.bullets).toHaveLength(4);
  });
});
