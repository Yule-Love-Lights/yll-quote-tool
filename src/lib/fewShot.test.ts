import { describe, it, expect } from 'vitest';
import { selectFewShot, FEW_SHOT_LIMIT } from './fewShot';
import type { FewShotExample } from './photoAnalysis';

// Minimal example tagged by santasFootage so we can track selection + order.
function ex(source: FewShotExample['source'], id: number): FewShotExample {
  return {
    photos: [],
    santasFootage: id,
    santasDifficulty: 'medium',
    santasLines: [],
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    gingerbreadLines: [],
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    source,
  };
}
const ids = (xs: FewShotExample[]) => xs.map((x) => x.santasFootage);

describe('selectFewShot', () => {
  it('FEW_SHOT_LIMIT is 8', () => {
    expect(FEW_SHOT_LIMIT).toBe(8);
  });

  it('under cap: returns all, ordered best-LAST (training → design w/ closest last)', () => {
    const design = [ex('design', 1), ex('design', 2)]; // 1 = closest (best-first input)
    const training = [ex('training', 10)];
    const out = selectFewShot({ design, training }, 8);
    // training first (least weight), then design reversed (closest match #1 sits LAST).
    expect(ids(out)).toEqual([10, 2, 1]);
  });

  it('over cap: design fills first, exactly `limit` returned', () => {
    const design = Array.from({ length: 10 }, (_, i) => ex('design', i)); // 0..9, 0 closest
    const out = selectFewShot({ design, training: [] }, 8);
    expect(out).toHaveLength(8);
    // design.slice(0,8) = 0..7, reversed → 7..0; closest (0) is LAST.
    expect(ids(out)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(out[out.length - 1].santasFootage).toBe(0); // closest match weighted most
  });

  it('priority: design fills before training, capped at `limit`', () => {
    const design = Array.from({ length: 6 }, (_, i) => ex('design', i));
    const training = Array.from({ length: 6 }, (_, i) => ex('training', 10 + i));
    const out = selectFewShot({ design, training }, 8);
    expect(out).toHaveLength(8);
    // 6 design + 2 training (cap reached before all training fits).
    expect(out.filter((x) => x.source === 'design')).toHaveLength(6);
    expect(out.filter((x) => x.source === 'training')).toHaveLength(2);
  });

  it('thin design library: training pads the remaining slots', () => {
    const design = [ex('design', 1)];
    const training = Array.from({ length: 10 }, (_, i) => ex('training', 10 + i));
    const out = selectFewShot({ design, training }, 8);
    expect(out).toHaveLength(8); // 1 design + 7 training
    expect(out.filter((x) => x.source === 'training')).toHaveLength(7);
    expect(out[out.length - 1].santasFootage).toBe(1); // design still last
  });

  it('empty sources → []', () => {
    expect(selectFewShot({ design: [], training: [] }, 8)).toEqual([]);
  });
});
