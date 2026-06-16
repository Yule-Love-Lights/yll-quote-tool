import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRenderSettings,
  setRenderSettings,
  DEFAULT_RENDER_SETTINGS,
} from './editor-core/renderSettings';

// renderSettings.ts is a vendored editor-core module (kept byte-identical with
// the design tool); this test lives OUTSIDE editor-core and imports in.
describe('renderSettings', () => {
  beforeEach(() => {
    // Reset the module global between tests.
    setRenderSettings(DEFAULT_RENDER_SETTINGS);
  });

  it('defaults to 0.45 spritzer ray density', () => {
    expect(getRenderSettings().spritzerRayDensity).toBe(0.45);
  });

  it('applies a valid spritzer ray density', () => {
    setRenderSettings({ spritzerRayDensity: 0.8 });
    expect(getRenderSettings().spritzerRayDensity).toBe(0.8);
  });

  it('ignores invalid values (NaN, <=0, non-number) and null/undefined', () => {
    setRenderSettings({ spritzerRayDensity: 0.7 });
    setRenderSettings({ spritzerRayDensity: NaN });
    expect(getRenderSettings().spritzerRayDensity).toBe(0.7);
    setRenderSettings({ spritzerRayDensity: 0 });
    expect(getRenderSettings().spritzerRayDensity).toBe(0.7);
    setRenderSettings({ spritzerRayDensity: -1 });
    expect(getRenderSettings().spritzerRayDensity).toBe(0.7);
    // @ts-expect-error — runtime guard against a non-number
    setRenderSettings({ spritzerRayDensity: 'big' });
    expect(getRenderSettings().spritzerRayDensity).toBe(0.7);
    setRenderSettings(null);
    setRenderSettings(undefined);
    expect(getRenderSettings().spritzerRayDensity).toBe(0.7);
  });
});
