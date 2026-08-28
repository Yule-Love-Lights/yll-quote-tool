import { afterEach, describe, expect, it, vi } from 'vitest';
import { brightnessForPhoto } from '@/lib/design/photoBrightness';
import type { Scene } from '@/lib/design/sceneTypes';
import { createEditorApi, SceneConflictError, SceneLockedError } from './storage';

const DESIGN_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('editor scene storage', () => {
  it('persists and reloads independent photo brightness', async () => {
    const scene: Scene = {
      yardsticks: [],
      items: [],
      brightness: 80,
      extraPhotoBrightness: { 'left-photo': 10, 'right-photo': 60 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: 2 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ design: { id: DESIGN_ID, scene } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const api = createEditorApi(DESIGN_ID);

    await api.updateDesign(DESIGN_ID, { scene });
    const reopened = await api.getDesign(DESIGN_ID);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/designs/${DESIGN_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ scene, version: null }),
      }),
    );
    expect(brightnessForPhoto(reopened.scene, null)).toBe(80);
    expect(brightnessForPhoto(reopened.scene, 'left-photo')).toBe(10);
    expect(brightnessForPhoto(reopened.scene, 'right-photo')).toBe(60);
  });

  // Ledger row 260, client half. The server's compare-and-swap answers a lost
  // race with a 409, and updateDesign turns that into SceneConflictError so the
  // editor can block and offer a reload instead of auto-retrying the same stale
  // overwrite forever. Before these tests the throw had NO coverage anywhere in
  // src: deleting the line left every editor-core suite green.
  it('throws SceneConflictError when the server rejects the compare-and-swap', async () => {
    const scene: Scene = { yardsticks: [], items: [], brightness: 80 };
    // Row 367: the 409 body is now read to tell a CAS conflict (no code) from
    // the post-approval design lock (code: 'design-locked'), so the fixture
    // needs the json() every real Response has.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) }));
    const api = createEditorApi(DESIGN_ID);

    await expect(api.updateDesign(DESIGN_ID, { scene })).rejects.toBeInstanceOf(SceneConflictError);
  });

  it('throws an ordinary Error, NOT SceneConflictError, on a non-409 save failure', async () => {
    const scene: Scene = { yardsticks: [], items: [], brightness: 80 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));
    const api = createEditorApi(DESIGN_ID);

    // The distinction is the whole point: a 500 is retryable, a 409 is not.
    const err = await api.updateDesign(DESIGN_ID, { scene }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SceneConflictError);
    expect(String(err.message)).toContain('500');
  });

  // Row 367, client half. The route can now answer a scene PUT with a SECOND
  // kind of 409 — the linked quote is customer-approved, so the design is
  // locked. It must NOT arrive as SceneConflictError: the conflict remedy is
  // "reload to see the latest version", which here would send staff round a
  // loop into the same lock.
  it('throws SceneLockedError on a 409 carrying code: design-locked', async () => {
    const scene: Scene = { yardsticks: [], items: [], brightness: 80 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'This design is locked — the customer already approved it.', code: 'design-locked' }),
      }),
    );
    const api = createEditorApi(DESIGN_ID);

    const err = await api.updateDesign(DESIGN_ID, { scene }).catch((e) => e);
    expect(err).toBeInstanceOf(SceneLockedError);
    expect(err).not.toBeInstanceOf(SceneConflictError);
    // The server's own copy rides through, so the banner text lives in ONE
    // place (sceneFreeze.ts) instead of being re-typed on the client.
    expect(String(err.message)).toContain('already approved');
  });

  it('falls back to SceneConflictError when a 409 body is unreadable', async () => {
    const scene: Scene = { yardsticks: [], items: [], brightness: 80 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new Error('not json'); } }),
    );
    const api = createEditorApi(DESIGN_ID);

    // Unreadable body = the pre-row-367 behaviour: treat it as the CAS
    // conflict, which is the safe read (blocks saving, offers a reload).
    await expect(api.updateDesign(DESIGN_ID, { scene })).rejects.toBeInstanceOf(SceneConflictError);
  });

  it('sends the caller version and round-trips the server new version back', async () => {
    const scene: Scene = { yardsticks: [], items: [], brightness: 80 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: 7 }) });
    vi.stubGlobal('fetch', fetchMock);
    const api = createEditorApi(DESIGN_ID);

    const saved = await api.updateDesign(DESIGN_ID, { scene, version: 6 });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/designs/${DESIGN_ID}`,
      expect.objectContaining({ body: JSON.stringify({ scene, version: 6 }) }),
    );
    expect(saved.version).toBe(7);
  });
});
