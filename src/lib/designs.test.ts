import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file unions two audit fixes' suites:
//   1. design upload size cap (audit #22) — the upload helpers must reject an
//      oversized decoded buffer BEFORE sharp() ever touches it.
//   2. design erasure (audit fix: customer-photo-retention-deletion) —
//      deleteDesign removes BOTH the row and every bucket object under the
//      design's `{id}/` prefix; deleteDesignsForQuote fans out per quote.
//
// Both suites mock the SAME supabase module (designs.ts imports from
// './supabase', and '@/lib/supabase' resolves to the same file via the @ alias),
// so there is exactly ONE vi.mock for it: it returns `sbRef.current`, which each
// suite controls. The upload-cap suite only needs a truthy client ({}) so getSb()
// doesn't short-circuit — its size guard throws before any storage/DB call.
// sharp is mocked so the upload-cap suite can assert it is never invoked.

const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({
    metadata: vi.fn(async () => ({ width: 1, height: 1 })),
    jpeg: vi.fn(() => ({ toBuffer: vi.fn(async () => Buffer.alloc(0)) })),
  })),
}));

vi.mock('sharp', () => ({ default: sharpMock }));

const { sbRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));

import {
  uploadDesignPhoto,
  uploadDesignSatellite,
  deleteDesign,
  deleteDesignsForQuote,
  createDesign,
  addDesignExtraPhoto,
  removeDesignExtraPhoto,
  updateDesignExtraPhotoTitle,
  getDesignWithPhoto,
  type DesignExtraPhoto,
} from './designs';

// ─── design upload size cap (audit #22) ─────────────────────────────────────

// 11MB of raw bytes → base64 of an over-the-cap image.
const oversizedBase64 = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');

describe('design upload size cap (audit #22)', () => {
  beforeEach(() => {
    sharpMock.mockClear();
    // A truthy stub is enough — the size guard runs before any storage/DB call.
    sbRef.current = {};
  });

  it('uploadDesignPhoto rejects a >10MB image before sharp runs', async () => {
    await expect(
      uploadDesignPhoto('11111111-1111-1111-1111-111111111111', oversizedBase64, 'image/jpeg'),
    ).rejects.toThrow(/too large/i);
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('uploadDesignSatellite rejects a >10MB image before sharp runs', async () => {
    await expect(
      uploadDesignSatellite('11111111-1111-1111-1111-111111111111', oversizedBase64, 'image/jpeg', null),
    ).rejects.toThrow(/too large/i);
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('addDesignExtraPhoto rejects a >10MB image before sharp runs', async () => {
    await expect(
      addDesignExtraPhoto('11111111-1111-1111-1111-111111111111', oversizedBase64, 'image/jpeg'),
    ).rejects.toThrow(/too large/i);
    expect(sharpMock).not.toHaveBeenCalled();
  });
});

// ─── extra street photos (#13 multi-image) ──────────────────────────────────
// A design's extras: stored under the design's own storage prefix, tracked in
// the extra_photos jsonb array, referenced by scene items via `photoId`.

// Fake Supabase for the extras suite: a designs row whose extra_photos/scene
// evolve through .update() calls, plus storage upload/remove recorders.
function makeExtrasSb(row: {
  extra_photos?: DesignExtraPhoto[] | null;
  scene?: { yardsticks: unknown[]; items: Array<Record<string, unknown>> };
  photo_path?: string | null;
}) {
  const state = {
    row: {
      id: ID,
      quote_id: null as string | null,
      photo_path: row.photo_path ?? null,
      photo_w: null,
      photo_h: null,
      scene: row.scene ?? { yardsticks: [], items: [] },
      extra_photos: row.extra_photos ?? null,
    } as Record<string, unknown>,
    uploadedPaths: [] as string[],
    removedPaths: [] as string[][],
    signedPaths: [] as string[],
  };

  const storage = {
    from: () => ({
      upload: async (path: string) => {
        state.uploadedPaths.push(path);
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        state.removedPaths.push(paths);
        return { data: null, error: null };
      },
      createSignedUrl: async (path: string) => {
        state.signedPaths.push(path);
        return { data: { signedUrl: `signed:${path}` }, error: null };
      },
    }),
  };

  function tableBuilder() {
    let selectCols = '*';
    let updatePayload: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: (cols?: string) => {
        selectCols = cols ?? '*';
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return b;
      },
      eq: () => b,
      maybeSingle: async () => {
        if (selectCols === 'extra_photos') {
          return { data: { extra_photos: state.row.extra_photos }, error: null };
        }
        return { data: { ...state.row }, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (updatePayload) Object.assign(state.row, updatePayload);
        resolve({ error: null });
      },
    });
    return b;
  }

  return { client: { storage, from: () => tableBuilder() }, state };
}

const PHOTO_A = 'aaaa1111-2222-4333-8444-555566667777';
const PHOTO_B = 'bbbb1111-2222-4333-8444-555566667777';

describe('extra street photos (#13)', () => {
  beforeEach(() => {
    sharpMock.mockClear();
    sbRef.current = null;
  });

  it('addDesignExtraPhoto stores under the design prefix and appends the entry', async () => {
    const { client, state } = makeExtrasSb({ extra_photos: null });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    const entry = await addDesignExtraPhoto(ID, tiny, 'image/jpeg', '  Left side  ');

    expect(state.uploadedPaths).toHaveLength(1);
    expect(state.uploadedPaths[0]).toBe(`${ID}/extra-${entry.id}.jpg`);
    expect(entry.title).toBe('Left side');
    const stored = state.row.extra_photos as DesignExtraPhoto[];
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(entry.id);
  });

  it('removeDesignExtraPhoto removes the object, the entry, and the photo\'s scene items', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [
        { id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null },
        { id: PHOTO_B, path: `${ID}/extra-${PHOTO_B}.jpg`, w: 10, h: 10, title: 'Back' },
      ],
      scene: {
        yardsticks: [],
        items: [
          { id: 'i1', kind: 'wreath', photoId: PHOTO_A },
          { id: 'i2', kind: 'wreath', photoId: PHOTO_B },
          { id: 'i3', kind: 'wreath' },
        ],
      },
    });
    sbRef.current = client;

    expect(await removeDesignExtraPhoto(ID, PHOTO_A)).toBe(true);

    expect(state.removedPaths).toEqual([[`${ID}/extra-${PHOTO_A}.jpg`]]);
    expect((state.row.extra_photos as DesignExtraPhoto[]).map(p => p.id)).toEqual([PHOTO_B]);
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    expect(items.map(i => i.id)).toEqual(['i2', 'i3']);
  });

  it('removeDesignExtraPhoto also prunes twins of a pruned canonical (#13)', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      scene: {
        yardsticks: [],
        items: [
          { id: 'canon', kind: 'wreath', photoId: PHOTO_A }, // canonical dies with its photo
          { id: 'twin-of-canon', kind: 'wreath', linkedToId: 'canon' }, // base-photo twin → dangling → pruned
          { id: 'unrelated', kind: 'wreath' },
        ],
      },
    });
    sbRef.current = client;

    expect(await removeDesignExtraPhoto(ID, PHOTO_A)).toBe(true);
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    expect(items.map(i => i.id)).toEqual(['unrelated']);
  });

  it('removeDesignExtraPhoto returns false for an unknown photo id', async () => {
    const { client, state } = makeExtrasSb({ extra_photos: [] });
    sbRef.current = client;
    expect(await removeDesignExtraPhoto(ID, PHOTO_A)).toBe(false);
    expect(state.removedPaths).toHaveLength(0);
  });

  it('updateDesignExtraPhotoTitle renames and clears (empty → null)', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: 'Old' }],
    });
    sbRef.current = client;

    expect(await updateDesignExtraPhotoTitle(ID, PHOTO_A, 'New name')).toBe(true);
    expect((state.row.extra_photos as DesignExtraPhoto[])[0].title).toBe('New name');

    expect(await updateDesignExtraPhotoTitle(ID, PHOTO_A, '   ')).toBe(true);
    expect((state.row.extra_photos as DesignExtraPhoto[])[0].title).toBeNull();

    expect(await updateDesignExtraPhotoTitle(ID, PHOTO_B, 'x')).toBe(false);
  });

  it('getDesignWithPhoto returns [] extras for pre-migration rows and signed entries when present', async () => {
    const bare = makeExtrasSb({ extra_photos: null });
    sbRef.current = bare.client;
    const withoutExtras = await getDesignWithPhoto(ID);
    expect(withoutExtras?.extraPhotos).toEqual([]);

    const populated = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side' }],
    });
    sbRef.current = populated.client;
    const withExtras = await getDesignWithPhoto(ID);
    expect(withExtras?.extraPhotos).toEqual([
      { id: PHOTO_A, url: `signed:${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side' },
    ]);
  });
});

// ─── design erasure (audit fix: customer-photo-retention-deletion) ──────────

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Fake Supabase: records storage list/remove calls + row deletes.
function makeSb(opts: {
  // objects returned by storage.list(prefix)
  objects?: Array<{ name: string }>;
  listError?: { message: string } | null;
  removeError?: { message: string } | null;
  rowDeleteError?: { message: string } | null;
  // rows returned by from('designs').select('id').eq('quote_id', q)
  designRows?: Array<{ id: string }>;
}) {
  const calls = {
    listedPrefixes: [] as string[],
    removedPaths: [] as string[][],
    deletedIds: [] as string[],
  };

  const storage = {
    from: () => ({
      list: async (prefix: string) => {
        calls.listedPrefixes.push(prefix);
        return { data: opts.objects ?? [], error: opts.listError ?? null };
      },
      remove: async (paths: string[]) => {
        calls.removedPaths.push(paths);
        return { data: null, error: opts.removeError ?? null };
      },
    }),
  };

  // Table builder: supports .delete().eq() (awaited) and .select().eq() (awaited).
  function tableBuilder() {
    let mode: 'delete' | 'select' = 'select';
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      delete: () => {
        mode = 'delete';
        return b;
      },
      select: () => {
        mode = 'select';
        return b;
      },
      eq: (col: string, val: string) => {
        if (mode === 'delete') (b as { _deleteId?: string })._deleteId = val;
        return b;
      },
      then: (resolve: (v: unknown) => void) => {
        if (mode === 'delete') {
          calls.deletedIds.push((b as { _deleteId?: string })._deleteId ?? '');
          resolve({ error: opts.rowDeleteError ?? null });
        } else {
          resolve({ data: opts.designRows ?? [], error: null });
        }
      },
    });
    return b;
  }

  return {
    client: { storage, from: () => tableBuilder() },
    calls,
  };
}

describe('deleteDesign (audit fix: customer-photo-retention-deletion)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('removes both the bucket objects and the row', async () => {
    const { client, calls } = makeSb({
      objects: [{ name: 'photo.jpg' }, { name: 'satellite.png' }],
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.listedPrefixes).toEqual([ID]);
    expect(calls.removedPaths).toEqual([[`${ID}/photo.jpg`, `${ID}/satellite.png`]]);
    expect(calls.deletedIds).toEqual([ID]);
  });

  it('extra-photo objects under the prefix ride the same erasure (#13 retention)', async () => {
    const { client, calls } = makeSb({
      objects: [{ name: 'photo.jpg' }, { name: 'satellite.png' }, { name: `extra-${PHOTO_A}.jpg` }],
    });
    sbRef.current = client;

    expect(await deleteDesign(ID)).toBe(true);
    expect(calls.removedPaths).toEqual([
      [`${ID}/photo.jpg`, `${ID}/satellite.png`, `${ID}/extra-${PHOTO_A}.jpg`],
    ]);
  });

  it('still deletes the row when there are no bucket objects', async () => {
    const { client, calls } = makeSb({ objects: [] });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.removedPaths).toEqual([]); // nothing to remove
    expect(calls.deletedIds).toEqual([ID]);
  });

  it('still deletes the row when storage removal fails (best-effort cleanup)', async () => {
    const { client, calls } = makeSb({
      objects: [{ name: 'photo.jpg' }],
      removeError: { message: 'boom' },
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);

    expect(ok).toBe(true);
    expect(calls.deletedIds).toEqual([ID]); // row still gone
  });

  it('reports failure when the row delete errors', async () => {
    const { client } = makeSb({
      objects: [],
      rowDeleteError: { message: 'db down' },
    });
    sbRef.current = client;

    const ok = await deleteDesign(ID);
    expect(ok).toBe(false);
  });

  it('returns false when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await deleteDesign(ID)).toBe(false);
  });
});

describe('deleteDesignsForQuote', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('deletes every design linked to the quote and returns the count', async () => {
    const id2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const { client, calls } = makeSb({
      designRows: [{ id: ID }, { id: id2 }],
      objects: [{ name: 'photo.jpg' }],
    });
    sbRef.current = client;

    const n = await deleteDesignsForQuote('quote-1');

    expect(n).toBe(2);
    expect(calls.deletedIds.sort()).toEqual([ID, id2].sort());
  });

  it('returns 0 when the quote has no linked designs', async () => {
    const { client } = makeSb({ designRows: [] });
    sbRef.current = client;
    expect(await deleteDesignsForQuote('quote-1')).toBe(0);
  });

  it('returns 0 when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await deleteDesignsForQuote('quote-1')).toBe(0);
  });
});

// ─── createDesign actor audit trail (#90) ───────────────────────────────────

// Minimal insert-capturing fake: createDesign with no photoBase64 only runs
// from('designs').insert({...}).select('id').single().
function makeInsertSb() {
  const inserts: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return builder;
    },
    select: () => builder,
    single: async () => ({ data: { id: 'd1' }, error: null }),
  };
  return { client: { from: () => builder }, inserts };
}

describe('createDesign created_by (#90)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('stamps the caller id into created_by', async () => {
    const sb = makeInsertSb();
    sbRef.current = sb.client;

    await createDesign({ createdBy: 'op-1' });

    expect(sb.inserts[0]).toMatchObject({ created_by: 'op-1' });
  });

  it('writes created_by null when no caller id', async () => {
    const sb = makeInsertSb();
    sbRef.current = sb.client;

    await createDesign({});

    expect(sb.inserts[0]).toMatchObject({ created_by: null });
  });
});
