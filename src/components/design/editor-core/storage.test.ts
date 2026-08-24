import { afterEach, describe, expect, it, vi } from 'vitest';
import { brightnessForPhoto } from '@/lib/design/photoBrightness';
import type { Scene } from '@/lib/design/sceneTypes';
import { createEditorApi } from './storage';

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
});
