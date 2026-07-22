import { describe, it, expect } from 'vitest';
import { SAMPLE_STYLES, buildSampleScene, SCHEME_COLOR_IDS } from './estimateSamples';

// The sample-home before/after renders through the REAL DesignCanvas engine, so
// each style must seed into a non-empty scene (strands the renderer can draw) —
// an empty scene would render a blank photo with no lights (the "ugly dots" the
// drawn overlay was replaced to fix must not regress into "no lights at all").
describe('buildSampleScene', () => {
  it('seeds a non-empty scene with an evening brightness for every sample style', () => {
    for (const style of SAMPLE_STYLES) {
      const scene = buildSampleScene(style);
      expect(scene.items.length, style.key).toBeGreaterThan(0);
      // Dimmed so the bulbs glow (not the neutral 50).
      expect(scene.brightness, style.key).toBeLessThan(50);
    }
  });

  it('exposes a real palette color id for every swatch scheme', () => {
    for (const ids of Object.values(SCHEME_COLOR_IDS)) {
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    }
  });
});
