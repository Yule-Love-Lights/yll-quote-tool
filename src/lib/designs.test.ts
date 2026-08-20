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
  updateDesignSceneGuarded,
  getDesignWithPhoto,
  getDesignByQuote,
  isValidDesignId,
  type DesignExtraPhoto,
  type DesignScene,
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

// ─── W2-014: replacing the base photo/satellite with a DIFFERENT extension
// must not orphan the old blob (upsert only overwrites the SAME storage key,
// so photo.png survives untouched when the replacement lands at photo.jpg). ─

// Fake Supabase for the extension-change suite: a designs row with an existing
// photo_path/satellite_path, plus storage upload/remove recorders.
function makeReplaceSb(row: { photo_path?: string | null; satellite_path?: string | null }) {
  const state = {
    row: { id: ID, photo_path: row.photo_path ?? null, satellite_path: row.satellite_path ?? null } as Record<string, unknown>,
    uploadedPaths: [] as string[],
    removedPaths: [] as string[][],
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
        if (selectCols === 'photo_path') return { data: { photo_path: state.row.photo_path }, error: null };
        if (selectCols === 'satellite_path') return { data: { satellite_path: state.row.satellite_path }, error: null };
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

describe('uploadDesignPhoto / uploadDesignSatellite orphan cleanup (W2-014)', () => {
  beforeEach(() => {
    sharpMock.mockClear();
    sbRef.current = null;
  });

  it('removes the old photo blob when the replacement has a DIFFERENT extension', async () => {
    const { client, state } = makeReplaceSb({ photo_path: `${ID}/photo.png` });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    const res = await uploadDesignPhoto(ID, tiny, 'image/jpeg');

    expect(res.path).toBe(`${ID}/photo.jpg`);
    expect(state.uploadedPaths).toEqual([`${ID}/photo.jpg`]);
    expect(state.removedPaths).toEqual([[`${ID}/photo.png`]]);
  });

  it('does NOT remove anything when the replacement keeps the SAME extension (upsert overwrites)', async () => {
    const { client, state } = makeReplaceSb({ photo_path: `${ID}/photo.jpg` });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    await uploadDesignPhoto(ID, tiny, 'image/jpeg');

    expect(state.removedPaths).toEqual([]);
  });

  it('does NOT remove anything for a first-ever upload (no prior photo_path)', async () => {
    const { client, state } = makeReplaceSb({ photo_path: null });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    await uploadDesignPhoto(ID, tiny, 'image/jpeg');

    expect(state.removedPaths).toEqual([]);
  });

  it('removes the old satellite blob when the replacement has a DIFFERENT extension', async () => {
    const { client, state } = makeReplaceSb({ satellite_path: `${ID}/satellite.png` });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    const res = await uploadDesignSatellite(ID, tiny, 'image/jpeg', null);

    expect(res.path).toBe(`${ID}/satellite.jpg`);
    expect(state.removedPaths).toEqual([[`${ID}/satellite.png`]]);
  });

  it('does NOT remove the satellite blob on a same-extension replacement', async () => {
    const { client, state } = makeReplaceSb({ satellite_path: `${ID}/satellite.jpg` });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    await uploadDesignSatellite(ID, tiny, 'image/jpeg', null);

    expect(state.removedPaths).toEqual([]);
  });
});

// ─── extra street photos (#13 multi-image) ──────────────────────────────────
// A design's extras: stored under the design's own storage prefix, tracked in
// the extra_photos jsonb array, referenced by scene items via `photoId`.

// Fake Supabase for the extras suite: a designs row whose extra_photos/scene
// evolve through .update() calls, plus storage upload/remove recorders.
// `onSceneRefetch` (W2-016) fires on the SECOND `select('scene')` read (the
// prune's fresh re-read, right before its write) — simulating a CONCURRENT
// autosave that already committed to the row by the time the prune re-reads,
// so the test can assert the prune's write doesn't clobber it.
function makeExtrasSb(row: {
  extra_photos?: DesignExtraPhoto[] | null;
  scene?: { yardsticks: unknown[]; items: Array<Record<string, unknown>> };
  photo_path?: string | null;
  // Ledger row 260: the scene CAS counter this row starts at (default 1,
  // matching the migration's NOT NULL DEFAULT 1).
  version?: number;
  onSceneRefetch?: (state: { row: Record<string, unknown> }) => void;
  onExtraPhotosRefetch?: (state: { row: Record<string, unknown> }) => void;
  // Ledger row 260: fires when a scene/version .update(...) call is made —
  // i.e. AFTER the fresh read has already returned, simulating a concurrent
  // writer landing in the narrow window between this attempt's read and its
  // CAS write (as opposed to onSceneRefetch, which fires DURING the read).
  onSceneWriteAttempt?: (state: { row: Record<string, unknown> }) => void;
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
      updated_at: 'v0',
      version: row.version ?? 1,
    } as Record<string, unknown>,
    uploadedPaths: [] as string[],
    removedPaths: [] as string[][],
    signedPaths: [] as string[],
    selectCalls: [] as string[],
    sceneOnlyReads: 0,
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

  let updateCounter = 0;

  function tableBuilder() {
    let selectCols = '*';
    let updatePayload: Record<string, unknown> | null = null;
    let selectAfterUpdate = false;
    const eqFilters: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: (cols?: string) => {
        if (updatePayload) {
          // .update(...).select(cols) — post-write row-match projection
          // (updateExtraPhotosAtomic's optimistic-concurrency guard).
          selectAfterUpdate = true;
        } else {
          selectCols = cols ?? '*';
          state.selectCalls.push(selectCols);
        }
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        if ('version' in payload && row.onSceneWriteAttempt) row.onSceneWriteAttempt(state);
        return b;
      },
      eq: (col: string, val: unknown) => {
        eqFilters.push([col, val]);
        return b;
      },
      maybeSingle: async () => {
        if (selectCols === 'extra_photos') {
          return { data: { extra_photos: state.row.extra_photos }, error: null };
        }
        if (selectCols === 'extra_photos, updated_at') {
          // updateExtraPhotosAtomic's per-attempt read — inject a concurrent
          // writer's effect right here, as if it committed between the
          // caller's initial snapshot read (above) and this guarded read.
          if (row.onExtraPhotosRefetch) row.onExtraPhotosRefetch(state);
          return { data: { extra_photos: state.row.extra_photos, updated_at: state.row.updated_at }, error: null };
        }
        if (selectCols === 'extra_photos, scene') {
          return { data: { extra_photos: state.row.extra_photos, scene: state.row.scene }, error: null };
        }
        if (selectCols === 'scene, version') {
          // Ledger row 260: the prune's FRESH re-read (now scene + the CAS
          // counter together) — inject the concurrent writer's effect right
          // here, as if it committed between the top-of-function read
          // (select('extra_photos, scene')) and this dedicated re-read.
          state.sceneOnlyReads += 1;
          if (row.onSceneRefetch) row.onSceneRefetch(state);
          return { data: { scene: state.row.scene, version: state.row.version }, error: null };
        }
        return { data: { ...state.row }, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (updatePayload) {
          // Optimistic-concurrency guard: every .eq(...) precondition on this
          // write must still match the CURRENT row, or another writer won the
          // race — the update matches zero rows (mirrors real Postgres). This
          // covers BOTH extra_photos' updated_at guard and the scene CAS's
          // version guard (ledger row 260) with the same generic check —
          // `id` is always present and always matches in this single-row mock.
          const preconditionOk = eqFilters.every(([col, val]) => state.row[col] === val);
          if (preconditionOk) {
            Object.assign(state.row, updatePayload);
            state.row.updated_at = `v${++updateCounter}`;
          }
          if (selectAfterUpdate) {
            resolve({ data: preconditionOk ? [{ id: state.row.id, version: state.row.version }] : [], error: null });
          } else {
            resolve({ error: null });
          }
        } else {
          resolve({ data: undefined, error: null });
        }
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

  it('addDesignExtraPhoto dedupes by telegramFileId — a repeat file id never appends twice', async () => {
    // The bot's retry / redelivery safety net: the same Telegram file is a no-op.
    const { client, state } = makeExtrasSb({ extra_photos: null });
    sbRef.current = client;
    const tiny = Buffer.from('img').toString('base64');

    const first = await addDesignExtraPhoto(ID, tiny, 'image/jpeg', 'Install', 'crew', 'tg-file-1');
    const second = await addDesignExtraPhoto(ID, tiny, 'image/jpeg', 'Install', 'crew', 'tg-file-1');

    const stored = state.row.extra_photos as DesignExtraPhoto[];
    expect(stored).toHaveLength(1);
    expect(second.id).toBe(first.id); // returns the existing entry, not a new append
    expect(stored[0].telegramFileId).toBe('tg-file-1');
    expect(stored[0].source).toBe('crew');
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

    expect((await removeDesignExtraPhoto(ID, PHOTO_A)).ok).toBe(true);

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

    expect((await removeDesignExtraPhoto(ID, PHOTO_A)).ok).toBe(true);
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    expect(items.map(i => i.id)).toEqual(['unrelated']);
  });

  // #227: deleting a photo removes every strand drawn on it. If that leaves a
  // miniGroup with zero surviving members, the group must be pruned too — it
  // would otherwise render nothing, be unselectable in the editor, and keep
  // billing its stringCount on every Calculate forever.
  it('removeDesignExtraPhoto prunes a miniGroup left with zero surviving members (#227) and reports it (#741 defect 3)', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      scene: {
        yardsticks: [],
        items: [
          { id: 's1', kind: 'strand', photoId: PHOTO_A, groupId: 'g1' },
          { id: 's2', kind: 'strand', photoId: PHOTO_A, groupId: 'g1' },
          { id: 'g1', kind: 'miniGroup', memberIds: ['s1', 's2'], surface: 'railing', stringCount: 8 },
          { id: 'unrelated', kind: 'wreath' },
        ],
      },
    });
    sbRef.current = client;

    const result = await removeDesignExtraPhoto(ID, PHOTO_A);
    expect(result.ok).toBe(true);
    // #741 defect 3: the caller (route → DesignEditor → QuoteBuilder) needs
    // to know a group was orphaned by this delete — previously silent.
    expect(result.prunedMiniGroups).toEqual([{ surface: 'railing', stringCount: 8 }]);
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    // s1/s2 pruned (drawn on the removed photo); g1 now has zero surviving
    // members and must be pruned too, not left dangling and still billed.
    expect(items.map(i => i.id)).toEqual(['unrelated']);
  });

  it('removeDesignExtraPhoto keeps a miniGroup with a surviving member elsewhere (partial orphan bills normally) (#227)', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      scene: {
        yardsticks: [],
        items: [
          { id: 's1', kind: 'strand', photoId: PHOTO_A, groupId: 'g1' }, // dies with the photo
          { id: 's2', kind: 'strand', groupId: 'g1' }, // on the base photo — survives
          { id: 'g1', kind: 'miniGroup', memberIds: ['s1', 's2'], surface: 'railing', stringCount: 8 },
        ],
      },
    });
    sbRef.current = client;

    const result = await removeDesignExtraPhoto(ID, PHOTO_A);
    expect(result.ok).toBe(true);
    // #741 defect 3: a group that SURVIVES (still has a member) must not be
    // reported as pruned — no false-positive staff warning.
    expect(result.prunedMiniGroups).toEqual([]);
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    expect(items.map(i => i.id).sort()).toEqual(['g1', 's2']);
  });

  // W2-016: a CONCURRENT scene autosave landing between the prune's read and
  // its write must not be clobbered by a stale-snapshot prune. Simulate the
  // race via onSceneUpdate: right before the prune's scene-only update fires,
  // inject a concurrent autosave that adds a brand-new item. The fix must
  // re-read the scene fresh immediately before writing, so the autosaved item
  // survives the prune (the OLD code used the initial-read snapshot and would
  // silently drop it).
  it('does not clobber a concurrent scene autosave with a stale prune (W2-016)', async () => {
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      scene: {
        yardsticks: [],
        items: [
          { id: 'i1', kind: 'wreath', photoId: PHOTO_A },
          { id: 'i2', kind: 'wreath' },
        ],
      },
      onSceneRefetch: (s) => {
        // A concurrent autosave lands between the prune's initial read and its
        // fresh re-read: staff adds a brand-new billable item on the base photo.
        const row = s.row as { scene: { yardsticks: unknown[]; items: Array<Record<string, unknown>> } };
        row.scene = {
          ...row.scene,
          items: [...row.scene.items, { id: 'autosaved', kind: 'tree' }],
        };
      },
    });
    sbRef.current = client;

    expect((await removeDesignExtraPhoto(ID, PHOTO_A)).ok).toBe(true);

    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    // i1 pruned (drawn on the removed photo); i2 kept; the concurrent
    // autosave's new item MUST survive, not be clobbered by a stale prune.
    expect(items.map(i => i.id).sort()).toEqual(['autosaved', 'i2']);
  });

  // Ledger row 260: the fresh read alone (W2-016 above) isn't enough once the
  // WRITE itself is a compare-and-swap — a writer that lands in the narrow
  // gap between this attempt's read and its CAS write must not make
  // removeDesignExtraPhoto give up. #741 defect 3's whole point was that this
  // prune must actually happen (an un-pruned scene resurrects dead-billing
  // miniGroups and dangling items) — a fail-fast 409 here would be a
  // regression, so a lost race must retry from a fresh read instead.
  it('retries the scene prune write when a concurrent writer wins the version race (ledger row 260)', async () => {
    let writeAttempts = 0;
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      scene: {
        yardsticks: [],
        items: [
          { id: 'i1', kind: 'wreath', photoId: PHOTO_A },
          { id: 'i2', kind: 'wreath' },
        ],
      },
      onSceneWriteAttempt: (s) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          // Simulate a concurrent writer's version bump landing between THIS
          // attempt's fresh read and its CAS write — the write must lose the
          // race (0 rows matched), and the caller must retry from a fresh
          // read rather than giving up.
          const r = s.row as { version: number };
          r.version += 1;
        }
      },
    });
    sbRef.current = client;

    const result = await removeDesignExtraPhoto(ID, PHOTO_A);
    expect(result.ok).toBe(true);
    expect(writeAttempts).toBe(2); // attempt 1 lost the race; attempt 2 (fresh read) won
    const items = (state.row.scene as { items: Array<{ id: string }> }).items;
    expect(items.map(i => i.id)).toEqual(['i2']);
    expect(state.row.version).toBe(3); // 1 (start) -> 2 (concurrent bump) -> 3 (this write)
  });

  it('removeDesignExtraPhoto returns false for an unknown photo id', async () => {
    const { client, state } = makeExtrasSb({ extra_photos: [] });
    sbRef.current = client;
    expect((await removeDesignExtraPhoto(ID, PHOTO_A)).ok).toBe(false);
    expect(state.removedPaths).toHaveLength(0);
  });

  // designs-atomic-extraphotos: removeDesignExtraPhoto's array write must go
  // through updateExtraPhotosAtomic (guarded read-then-write), not a plain
  // write off the top-of-function snapshot — otherwise a writer that lands in
  // between (another add, a rename, a removal) is silently dropped.
  it('removeDesignExtraPhoto does not drop a photo added by a concurrent writer (guarded atomic write)', async () => {
    let applied = false;
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: null }],
      onExtraPhotosRefetch: (s) => {
        if (applied) return;
        applied = true;
        // A concurrent addDesignExtraPhoto lands between this function's
        // top-of-function snapshot read and its guarded write.
        const r = s.row as { extra_photos: DesignExtraPhoto[]; updated_at: string };
        r.extra_photos = [
          ...r.extra_photos,
          { id: PHOTO_B, path: `${ID}/extra-${PHOTO_B}.jpg`, w: 5, h: 5, title: null },
        ];
        r.updated_at = 'concurrent-add';
      },
    });
    sbRef.current = client;

    expect((await removeDesignExtraPhoto(ID, PHOTO_A)).ok).toBe(true);

    // PHOTO_A removed; the concurrently-added PHOTO_B must survive, not be
    // clobbered by a write computed off the stale initial snapshot.
    expect((state.row.extra_photos as DesignExtraPhoto[]).map(p => p.id)).toEqual([PHOTO_B]);
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

  // designs-atomic-extraphotos: updateDesignExtraPhotoTitle's array write must
  // go through updateExtraPhotosAtomic too, for the same reason as remove.
  it('updateDesignExtraPhotoTitle does not drop a photo added by a concurrent writer (guarded atomic write)', async () => {
    let applied = false;
    const { client, state } = makeExtrasSb({
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 10, h: 10, title: 'Old' }],
      onExtraPhotosRefetch: (s) => {
        if (applied) return;
        applied = true;
        const r = s.row as { extra_photos: DesignExtraPhoto[]; updated_at: string };
        r.extra_photos = [
          ...r.extra_photos,
          { id: PHOTO_B, path: `${ID}/extra-${PHOTO_B}.jpg`, w: 5, h: 5, title: null },
        ];
        r.updated_at = 'concurrent-add';
      },
    });
    sbRef.current = client;

    expect(await updateDesignExtraPhotoTitle(ID, PHOTO_A, 'New name')).toBe(true);

    const stored = state.row.extra_photos as DesignExtraPhoto[];
    expect(stored.map(p => p.id).sort()).toEqual([PHOTO_A, PHOTO_B].sort());
    expect(stored.find(p => p.id === PHOTO_A)?.title).toBe('New name');
    expect(stored.find(p => p.id === PHOTO_B)).toBeTruthy(); // not dropped
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
      { id: PHOTO_A, url: `signed:${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side', source: null },
    ]);
  });

  it('preserves source: crew through the loader so portalPhotos can filter install photos', async () => {
    // The customer-safety guarantee lives in portalPhotos() filtering p.source
    // !== 'crew' — which is dead if the loader drops source. This is the
    // end-to-end coverage that the isolated portalPhotos test can't give.
    const populated = makeExtrasSb({
      extra_photos: [
        { id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side' },
        { id: PHOTO_B, path: `${ID}/extra-${PHOTO_B}.jpg`, w: 5, h: 5, title: 'Install photo — job #142', source: 'crew' },
      ],
    });
    sbRef.current = populated.client;
    const d = await getDesignWithPhoto(ID);
    expect(d?.extraPhotos.map((p) => p.source)).toEqual([null, 'crew']);
  });
});

// Ledger row 260: updateDesignSceneGuarded — the compare-and-swap scene
// write. A minimal, purpose-built fake distinct from makeExtrasSb (that one's
// tailored to extra_photos' updated_at-based guard); this one models exactly
// the two query shapes updateDesignSceneGuarded issues:
//   guarded:  .update({scene,version}).eq('id',id).eq('version',expected).select('version')
//   adopt:    .update({scene,version:1}).eq('id',id).select('version').maybeSingle()
function makeSceneOnlySb(initial: { scene: DesignScene; version: number }) {
  const state = { row: { id: ID, scene: initial.scene, version: initial.version } as Record<string, unknown> };
  function tableBuilder() {
    let updatePayload: Record<string, unknown> | null = null;
    const eqFilters: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      update: (payload: Record<string, unknown>) => { updatePayload = payload; return b; },
      eq: (col: string, val: unknown) => { eqFilters.push([col, val]); return b; },
      select: (_cols?: string) => b,
      maybeSingle: async () => {
        // Only the ADOPT path calls .maybeSingle() after .update() — no
        // 'version' eq filter, so the precondition is vacuously true (an
        // unconditional write, by design).
        const preconditionOk = eqFilters.every(([col, val]) => state.row[col] === val);
        if (updatePayload && preconditionOk) Object.assign(state.row, updatePayload);
        if (!updatePayload) return { data: { ...state.row }, error: null };
        return { data: preconditionOk ? { version: state.row.version } : null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (!updatePayload) { resolve({ data: undefined, error: null }); return; }
        const preconditionOk = eqFilters.every(([col, val]) => state.row[col] === val);
        if (preconditionOk) Object.assign(state.row, updatePayload);
        resolve({ data: preconditionOk ? [{ version: state.row.version }] : [], error: null });
      },
    });
    return b;
  }
  return { client: { from: () => tableBuilder() }, state };
}

describe('updateDesignSceneGuarded (ledger row 260 — scene compare-and-swap)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('wins the CAS: version matches, scene writes, version bumps by exactly 1', async () => {
    const scene: DesignScene = { yardsticks: [], items: [{ id: 'i1', kind: 'wreath' } as never] };
    const { client, state } = makeSceneOnlySb({ scene: { yardsticks: [], items: [] }, version: 5 });
    sbRef.current = client;

    const outcome = await updateDesignSceneGuarded(ID, scene, 5);

    expect(outcome).toEqual({ ok: true, version: 6 });
    expect(state.row.version).toBe(6);
    expect(state.row.scene).toEqual(scene);
  });

  it('loses the race: a concurrent writer already moved the version — reports conflict, does NOT touch the row', async () => {
    const scene: DesignScene = { yardsticks: [], items: [{ id: 'i1', kind: 'wreath' } as never] };
    // The row is already at version 6 (a concurrent write already landed) by
    // the time this caller — still holding a stale read of 5 — attempts its write.
    const { client, state } = makeSceneOnlySb({ scene: { yardsticks: [], items: [{ id: 'concurrent' } as never] }, version: 6 });
    sbRef.current = client;

    const outcome = await updateDesignSceneGuarded(ID, scene, 5);

    expect(outcome).toEqual({ ok: false, reason: 'conflict' });
    // The concurrent writer's data must survive untouched — this is the whole
    // point of the guard: a lost race must never silently overwrite.
    expect(state.row.version).toBe(6);
    expect(state.row.scene).toEqual({ yardsticks: [], items: [{ id: 'concurrent' }] });
  });

  it('adopts when expectedVersion is null: writes unconditionally and seeds version to 1', async () => {
    const scene: DesignScene = { yardsticks: [], items: [{ id: 'i1', kind: 'wreath' } as never] };
    // Any starting version — the adopt path doesn't check it.
    const { client, state } = makeSceneOnlySb({ scene: { yardsticks: [], items: [] }, version: 47 });
    sbRef.current = client;

    const outcome = await updateDesignSceneGuarded(ID, scene, null);

    expect(outcome).toEqual({ ok: true, version: 1 });
    expect(state.row.version).toBe(1);
    expect(state.row.scene).toEqual(scene);
  });

  it('adopts when expectedVersion is undefined too (a caller with no prior read)', async () => {
    const scene: DesignScene = { yardsticks: [], items: [] };
    const { client } = makeSceneOnlySb({ scene: { yardsticks: [], items: [] }, version: 3 });
    sbRef.current = client;

    const outcome = await updateDesignSceneGuarded(ID, scene, undefined);

    expect(outcome).toEqual({ ok: true, version: 1 });
  });
});

// W4-033: getDesignWithPhoto (the editor GET / portal-adjacent load) must
// select ONLY the columns toDesignWithPhoto reads — never seed_analysis (the
// raw AI-analysis jsonb the portal/editor never render) or a raw select('*').
// The fake below returns EXACTLY the narrowed row (no seed_analysis field at
// all), proving the full DesignWithPhoto shape is covered without it.
describe('getDesignWithPhoto column narrowing (W4-033)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('selects only the columns toDesignWithPhoto needs, and the result is fully populated', async () => {
    let selectedCols = '';
    const narrowRow = {
      id: ID,
      quote_id: 'quote-1',
      scene: { yardsticks: [], items: [] },
      photo_path: `${ID}/photo.jpg`,
      photo_w: 800,
      photo_h: 600,
      satellite_path: `${ID}/satellite.jpg`,
      satellite_w: 400,
      satellite_h: 400,
      satellite_feet_per_pixel: 0.35, // #142: rehydrates the builder's satellite scale
      satellite_lines: { santas: [], gingerbread: [], c9: [] },
      extra_photos: [{ id: PHOTO_A, path: `${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side' }],
      photo_title: 'Front',
      // Deliberately NO seed_analysis / created_at / updated_at — a real
      // narrowed select() from Supabase wouldn't return them either, so their
      // absence here proves toDesignWithPhoto doesn't need them.
    };
    const client = {
      storage: {
        from: () => ({
          createSignedUrl: async (path: string) => ({ data: { signedUrl: `signed:${path}` }, error: null }),
        }),
      },
      from: (table: string) => {
        expect(table).toBe('designs');
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: (cols: string) => {
            selectedCols = cols;
            return b;
          },
          eq: (col: string, val: string) => {
            expect(col).toBe('id');
            expect(val).toBe(ID);
            return b;
          },
          maybeSingle: async () => ({ data: narrowRow, error: null }),
        });
        return b;
      },
    };
    sbRef.current = client;

    const result = await getDesignWithPhoto(ID);

    expect(selectedCols).not.toBe('*');
    expect(selectedCols).not.toMatch(/seed_analysis/);
    expect(selectedCols).toMatch(/satellite_feet_per_pixel/); // #142: the builder rehydrate reads it
    // The full DesignWithPhoto shape is still populated from the narrowed row.
    expect(result).toEqual({
      id: ID,
      quoteId: 'quote-1',
      scene: { yardsticks: [], items: [] },
      photoUrl: `signed:${ID}/photo.jpg`,
      photoW: 800,
      photoH: 600,
      satelliteUrl: `signed:${ID}/satellite.jpg`,
      satelliteW: 400,
      satelliteH: 400,
      satelliteFeetPerPixel: 0.35,
      satelliteLines: { santas: [], gingerbread: [], c9: [] },
      extraPhotos: [{ id: PHOTO_A, url: `signed:${ID}/extra-${PHOTO_A}.jpg`, w: 20, h: 10, title: 'Side', source: null }],
      photoTitle: 'Front',
      // narrowRow (below) carries no `version` — proving toDesignWithPhoto's
      // `row.version ?? 1` default (ledger row 260) rather than a real column.
      version: 1,
    });
  });
});

// W2-031: getDesignByQuote used to select('id') by quote_id, then re-select
// the FULL row by id via getDesignWithPhoto — two sequential queries for one
// row. It must now do a single query by quote_id.
// W4-033: that single query is narrowed to the columns toDesignWithPhoto
// actually reads (never select('*'), never seed_analysis).
describe('getDesignByQuote (W2-031 / W4-033)', () => {
  it('resolves the design in a single, narrowed query (not two, not select(*))', async () => {
    let queryCount = 0;
    const row = {
      id: ID,
      quote_id: 'quote-1',
      photo_path: null,
      photo_w: null,
      photo_h: null,
      scene: { yardsticks: [], items: [] },
      extra_photos: null,
    };
    const client = {
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'n/a' } }) }) },
      from: (table: string) => {
        expect(table).toBe('designs');
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: (cols: string) => {
            queryCount += 1;
            expect(cols).not.toBe('*'); // never the old select('id') NOR a raw select('*')
            expect(cols).not.toMatch(/seed_analysis/); // portal load never pulls the raw AI jsonb
            return b;
          },
          eq: (col: string, val: string) => {
            expect(col).toBe('quote_id');
            expect(val).toBe('quote-1');
            return b;
          },
          maybeSingle: async () => ({ data: row, error: null }),
        });
        return b;
      },
    };
    sbRef.current = client;

    const result = await getDesignByQuote('quote-1');

    expect(queryCount).toBe(1);
    expect(result?.id).toBe(ID);
    expect(result?.quoteId).toBe('quote-1');
  });

  it('returns null when no design is linked to the quote', async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
        });
        return b;
      },
    };
    sbRef.current = client;

    expect(await getDesignByQuote('quote-none')).toBeNull();
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

  // W2-034: the per-design delete loop runs in bounded-concurrency chunks
  // (not a one-at-a-time await) — assert correctness holds across a chunk
  // boundary (10 designs > the 8-per-chunk size).
  it('deletes every design across a chunk boundary (10 designs, chunk size 8)', async () => {
    const designRows = Array.from({ length: 10 }, (_, i) => ({
      id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`,
    }));
    const { client, calls } = makeSb({ designRows, objects: [] });
    sbRef.current = client;

    const n = await deleteDesignsForQuote('quote-1');

    expect(n).toBe(10);
    expect(calls.deletedIds.sort()).toEqual(designRows.map((r) => r.id).sort());
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

// ─── createDesign seedFailed (W2-030) ───────────────────────────────────────
// The create-row → upload-photo → seed-scene sequence is deliberately
// best-effort (a failed seed doesn't fail the whole design create), but the
// failure used to be swallowed entirely — the caller had no way to tell a
// fully-seeded design from a partial/orphaned one. seedFailed surfaces it.

// A fake whose storage.upload() throws — simulates uploadDesignPhoto failing
// mid-seed (after the row already exists).
function makeSeedFailureSb() {
  const builder: Record<string, unknown> = {
    insert: () => builder,
    select: () => builder,
    single: async () => ({ data: { id: 'd1' }, error: null }),
    update: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { photo_path: null }, error: null }),
  };
  const storage = {
    from: () => ({
      upload: async () => {
        throw new Error('storage upload failed');
      },
    }),
  };
  return { client: { storage, from: () => builder } };
}

describe('createDesign seedFailed (W2-030)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('reports seedFailed=true when the photo/seed step throws, but still returns the created id', async () => {
    sbRef.current = makeSeedFailureSb().client;

    const res = await createDesign({ photoBase64: Buffer.from('img').toString('base64') });

    expect(res).not.toBeNull();
    expect(res?.id).toBe('d1'); // the row still exists — best-effort intent preserved
    expect(res?.seedFailed).toBe(true);
  });

  it('reports seedFailed=false when there is no photo to seed (nothing attempted)', async () => {
    const sb = makeInsertSb();
    sbRef.current = sb.client;

    const res = await createDesign({});

    expect(res?.seedFailed).toBe(false);
  });

  it('reports seedFailed=false on a successful photo seed', async () => {
    const inserts: Record<string, unknown>[] = [];
    const builder: Record<string, unknown> = {
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return builder;
      },
      select: () => builder,
      single: async () => ({ data: { id: 'd1' }, error: null }),
      update: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: { photo_path: null }, error: null }),
    };
    const storage = {
      from: () => ({
        upload: async () => ({ data: { path: 'd1/photo.jpg' }, error: null }),
      }),
    };
    sbRef.current = { storage, from: () => builder };

    const res = await createDesign({ photoBase64: Buffer.from('img').toString('base64') });

    expect(res?.seedFailed).toBe(false);
  });
});

// W2-029: isValidDesignId's regex must be a real UUID shape, not just "36
// chars of hex/dash" — the old /^[0-9a-f-]{36}$/i accepted malformed ids like
// 36 dashes, or hex in the wrong grouping.
describe('isValidDesignId (W2-029)', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidDesignId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('rejects 36 dashes (old regex accepted this)', () => {
    expect(isValidDesignId('-'.repeat(36))).toBe(false);
  });

  it('rejects hex in the wrong grouping (right length, wrong shape)', () => {
    // 36 chars, all valid hex/dash chars, but not 8-4-4-4-12 grouping.
    expect(isValidDesignId('123456789-abc-def0-1234-56789abcdef0')).toBe(false);
  });

  it('rejects non-string and empty input', () => {
    expect(isValidDesignId(null)).toBe(false);
    expect(isValidDesignId(undefined)).toBe(false);
    expect(isValidDesignId('')).toBe(false);
    expect(isValidDesignId(12345)).toBe(false);
  });
});
