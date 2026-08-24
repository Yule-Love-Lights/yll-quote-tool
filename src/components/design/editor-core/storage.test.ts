import { afterEach, describe, expect, it, vi } from 'vitest';
import { brightnessForPhoto } from '@/lib/design/photoBrightness';
import type { Scene } from '@/lib/design/sceneTypes';
import { createEditorApi, SceneConflictError } from './storage';

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 409 }));
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
