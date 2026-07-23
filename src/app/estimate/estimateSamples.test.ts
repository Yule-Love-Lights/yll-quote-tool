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

  it('fixes the render scale so bulbs are a normal size, not tiny (px/ft regression)', () => {
    // Bulb size + spacing both scale with the yardstick's px/ft. The fabricated
    // footage produced ~5 px/ft (bulbs tiny + crammed); the override must give a
    // normal density. One yardstick, px/ft = width/realFeet well above the broken 5.
    for (const style of SAMPLE_STYLES) {
      const ys = buildSampleScene(style).yardsticks;
      expect(ys.length, style.key).toBe(1);
      const ppf = ys[0].width / ys[0].realFeet;
      expect(ppf, style.key).toBeGreaterThan(20);
      expect(ppf, style.key).toBeLessThan(45); // and not "comically large" (>50)
    }
  });

  it('exposes a real palette color id for every swatch scheme', () => {
    for (const ids of Object.values(SCHEME_COLOR_IDS)) {
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    }
  });
});
