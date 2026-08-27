import { describe, it, expect, beforeEach, vi } from 'vitest';

// cloneDesignToNewQuote (designs.ts) — the Phase 5 rebook clone primitive. Mocks
// Supabase (designs table + storage) and sharp (unused here but imported by the
// module). Asserts: scene + measurement context copy, base photo + satellite are
// server-side-copied to the NEW prefix, and a failed copy leaves the path NULL
// (never shares the source path).

vi.mock('sharp', () => ({ default: vi.fn() }));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { cloneDesignToNewQuote } from './designs';

type Row = Record<string, unknown>;

function makeFake(opts: {
  source?: Row | null;
  objects?: Array<{ name: string }>;
  copyFailFor?: (from: string) => boolean;
  listError?: { message: string } | null;
}) {
  const designs: Row[] = opts.source ? [{ ...opts.source }] : [];
  const copies: Array<[string, string]> = [];
  let counter = 0;

  function from() {
    const state = {
      op: null as null | 'select' | 'insert' | 'update',
      insertRow: null as Row | null,
      updateRow: null as Row | null,
      filters: [] as Array<(r: Row) => boolean>,
    };
    const match = () => designs.filter((r) => state.filters.every((f) => f(r)));
    const doInsert = () => {
      const row = { id: `design-${++counter}`, ...state.insertRow };
      designs.push(row);
      return row;
    };
    const builder = {
      select() {
        if (state.op === null) state.op = 'select';
        return builder;
      },
      insert(row: Row) {
        state.op = 'insert';
        state.insertRow = row;
        return builder;
      },
      update(row: Row) {
        state.op = 'update';
        state.updateRow = row;
        return builder;
      },
      eq(col: string, val: unknown) {
        state.filters.push((r) => r[col] === val);
        return builder;
      },
      async maybeSingle() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        return { data: match()[0] ?? null, error: null };
      },
      async single() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        const out = match();
        return { data: out[0] ?? null, error: out[0] ? null : { message: 'no rows' } };
      },
      then(resolve: (v: unknown) => void) {
        if (state.op === 'insert') return resolve({ data: doInsert(), error: null });
        if (state.op === 'update') {
          for (const r of match()) Object.assign(r, state.updateRow);
          return resolve({ data: null, error: null });
        }
        return resolve({ data: match(), error: null });
      },
    };
    return builder;
  }

  const storage = {
    from() {
      return {
        async list() {
          return { data: opts.objects ?? [], error: opts.listError ?? null };
        },
        async copy(fromPath: string, toPath: string) {
          if (opts.copyFailFor?.(fromPath)) return { data: null, error: { message: 'copy failed' } };
          copies.push([fromPath, toPath]);
          return { data: { path: toPath }, error: null };
        },
      };
    },
  };

  return { client: { from, storage }, designs, copies };
}

beforeEach(() => {
  sbRef.current = null;
});

const SOURCE = {
  id: 'src-design',
  quote_id: 'src-quote',
  photo_path: 'src-design/photo.jpg',
  photo_w: 800,
  photo_h: 600,
  scene: { yardsticks: [], items: [{ id: 'x' }], brightness: 20 },
  satellite_path: 'src-design/satellite.png',
  satellite_w: 400,
  satellite_h: 400,
  satellite_feet_per_pixel: 0.5,
  satellite_lines: { santas: [{ points: [[0, 0]], label: 'a' }] },
  seed_analysis: { foo: 'bar' },
};

// W2-001/012/013: a source with extra_photos (#13 multi-image) — the field the
// clone used to drop entirely, orphaning scene items that reference an extra
// via photoId.
const SOURCE_WITH_EXTRAS = {
  ...SOURCE,
  photo_title: 'Front of house',
  extra_photos: [
    { id: 'extra-1', path: 'src-design/extra-extra-1.jpg', w: 640, h: 480, title: 'Side yard' },
    { id: 'extra-2', path: 'src-design/extra-extra-2.png', w: 500, h: 500, title: null },
  ],
  scene: {
    yardsticks: [],
    items: [
      { id: 'x' }, // base photo item (no photoId)
      { id: 'y', photoId: 'extra-1' }, // drawn on the first extra
    ],
    brightness: 20,
  },
};

describe('cloneDesignToNewQuote', () => {
  it('clones scene + measurement context and copies photo + satellite to the new prefix', async () => {
    const fake = makeFake({
      source: SOURCE,
      objects: [{ name: 'photo.jpg' }, { name: 'satellite.png' }],
    });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    expect(res?.id).toBeTruthy();
    const newId = res!.id;

    // A new design row, linked to the new quote, with the copied scene.
    const clone = fake.designs.find((d) => d.id === newId)!;
    expect(clone.quote_id).toBe('new-quote');
    expect(clone.scene).toEqual(SOURCE.scene);

    // Storage objects copied src prefix → new prefix.
    expect(fake.copies).toEqual([
      ['src-design/photo.jpg', `${newId}/photo.jpg`],
      ['src-design/satellite.png', `${newId}/satellite.png`],
    ]);

    // Row points at the COPIED artifacts + carries the in-row jsonb context.
    expect(clone.photo_path).toBe(`${newId}/photo.jpg`);
    expect(clone.photo_w).toBe(800);
    expect(clone.satellite_path).toBe(`${newId}/satellite.png`);
    expect(clone.satellite_feet_per_pixel).toBe(0.5);
    expect(clone.satellite_lines).toEqual(SOURCE.satellite_lines);
    expect(clone.seed_analysis).toEqual(SOURCE.seed_analysis);
  });

  it('resets hidden portal imagery to visible on the new quote', async () => {
    const fake = makeFake({
      source: {
        ...SOURCE,
        portal_show_street_view: false,
        portal_show_satellite_view: false,
      },
      objects: [],
    });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const clone = fake.designs.find((d) => d.id === res!.id)!;

    expect(clone.portal_show_street_view).toBe(true);
    expect(clone.portal_show_satellite_view).toBe(true);
  });

  it('returns null when the source quote has no design', async () => {
    const fake = makeFake({ source: null });
    sbRef.current = fake.client;
    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    expect(res).toBeNull();
    expect(fake.designs).toHaveLength(0);
  });

  it('leaves photo_path NULL when its copy fails (never shares the source path)', async () => {
    const fake = makeFake({
      source: SOURCE,
      objects: [{ name: 'photo.jpg' }, { name: 'satellite.png' }],
      copyFailFor: (from) => from.endsWith('photo.jpg'),
    });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const clone = fake.designs.find((d) => d.id === res!.id)!;
    expect(clone.photo_path).toBeNull();
    expect(clone.photo_w).toBeNull();
    // Satellite still copied fine.
    expect(clone.satellite_path).toBe(`${res!.id}/satellite.png`);
  });

  // W2-032: cloneDesignToNewQuote must stamp created_by like createDesign/
  // saveQuote do on every other design-creation path — otherwise a rebooked
  // clone lands with a NULL creator, a gap in the #90 audit trail.
  it('stamps created_by on the clone when given', async () => {
    const fake = makeFake({ source: SOURCE, objects: [] });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote', 'op-1');
    const clone = fake.designs.find((d) => d.id === res!.id)!;
    expect(clone.created_by).toBe('op-1');
  });

  it('writes created_by null when no actor is given', async () => {
    const fake = makeFake({ source: SOURCE, objects: [] });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const clone = fake.designs.find((d) => d.id === res!.id)!;
    expect(clone.created_by).toBeNull();
  });

  // W2-001/012/013: extra_photos (+ photo_title) must carry over, remapped to
  // the new design's storage prefix — otherwise a rebooked multi-photo design
  // loses every secondary street photo and orphans their photoId-tagged scene
  // items (the scene copies verbatim, but the photos it references vanish).
  it('carries extra_photos + photo_title, remapped to the new prefix', async () => {
    const fake = makeFake({
      source: SOURCE_WITH_EXTRAS,
      objects: [
        { name: 'photo.jpg' },
        { name: 'satellite.png' },
        { name: 'extra-extra-1.jpg' },
        { name: 'extra-extra-2.png' },
      ],
    });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const newId = res!.id;
    const clone = fake.designs.find((d) => d.id === newId)!;

    // Base photo + satellite still copy as before.
    expect(clone.photo_path).toBe(`${newId}/photo.jpg`);
    expect(clone.photo_title).toBe('Front of house');

    // The extra-* blobs are copied to the new prefix...
    expect(fake.copies).toEqual(
      expect.arrayContaining([
        ['src-design/extra-extra-1.jpg', `${newId}/extra-extra-1.jpg`],
        ['src-design/extra-extra-2.png', `${newId}/extra-extra-2.png`],
      ]),
    );

    // ...and extra_photos on the clone points at the COPIED paths, keeping the
    // SAME id (scene items' photoId references the extra's id, not its path)
    // and title.
    expect(clone.extra_photos).toEqual([
      { id: 'extra-1', path: `${newId}/extra-extra-1.jpg`, w: 640, h: 480, title: 'Side yard' },
      { id: 'extra-2', path: `${newId}/extra-extra-2.png`, w: 500, h: 500, title: null },
    ]);

    // The scene (copied verbatim) still references extra-1 by the SAME id, so
    // the item is reachable on the cloned design's extra photo tab.
    const cloneScene = clone.scene as { items: Array<{ id: string; photoId?: string }> };
    expect(cloneScene.items.find((it) => it.id === 'y')?.photoId).toBe('extra-1');
  });

  it('drops only the extras whose blob copy failed (never a dangling/mismatched entry)', async () => {
    const fake = makeFake({
      source: SOURCE_WITH_EXTRAS,
      objects: [
        { name: 'photo.jpg' },
        { name: 'satellite.png' },
        { name: 'extra-extra-1.jpg' },
        { name: 'extra-extra-2.png' },
      ],
      copyFailFor: (from) => from.endsWith('extra-extra-2.png'),
    });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const clone = fake.designs.find((d) => d.id === res!.id)!;

    // Only the successfully-copied extra survives on the clone.
    expect(clone.extra_photos).toEqual([
      { id: 'extra-1', path: `${res!.id}/extra-extra-1.jpg`, w: 640, h: 480, title: 'Side yard' },
    ]);
  });

  it('carries an empty extra_photos array (and null photo_title) when the source has none', async () => {
    const fake = makeFake({ source: SOURCE, objects: [{ name: 'photo.jpg' }] });
    sbRef.current = fake.client;

    const res = await cloneDesignToNewQuote('src-quote', 'new-quote');
    const clone = fake.designs.find((d) => d.id === res!.id)!;
    expect(clone.extra_photos).toEqual([]);
    expect(clone.photo_title).toBeNull();
  });
});
