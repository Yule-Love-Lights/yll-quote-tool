import { describe, it, expect } from 'vitest';
import { SCHEME_COLOR_IDS, SCHEMES } from './estimateSamples';

// The landing gallery recolors a featured real design via DesignCanvas
// colorOverride, so every swatch must map to at least one real palette color id.
describe('estimate swatches', () => {
  it('exposes a real palette color id for every swatch scheme', () => {
    for (const key of Object.keys(SCHEMES) as (keyof typeof SCHEMES)[]) {
      const ids = SCHEME_COLOR_IDS[key];
      expect(ids?.length, key).toBeGreaterThan(0);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0), key).toBe(true);
    }
  });
});
