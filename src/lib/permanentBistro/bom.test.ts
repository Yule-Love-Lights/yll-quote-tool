import { describe, it, expect } from 'vitest';
import { buildBistroBom, type BistroBomInput } from './bom';

// A minimal empty-job input; override per test.
function input(over: Partial<BistroBomInput> = {}): BistroBomInput {
  return { runs: [], poles: 0, ...over };
}

const line = (bom: ReturnType<typeof buildBistroBom>, sku: string) =>
  bom.lines.find((l) => l.sku === sku);

// Naldo's worked example (2026-07-11): 3 strands (40/35/25 ft = 100 ft total), 2 poles.
const WORKED_RUNS = [40, 35, 25];

describe('buildBistroBom — worked example (runs=[40,35,25], poles=2)', () => {
  const bom = buildBistroBom(input({ runs: WORKED_RUNS, poles: 2 }));

  it('totals: 100 ft, 3 strands, 2 poles', () => {
    expect(bom.totals.totalFootage).toBe(100);
    expect(bom.totals.strands).toBe(3);
    expect(bom.totals.poles).toBe(2);
  });

  it('cord (80324): 1×330ft section, needed footage in the description', () => {
    const l = line(bom, '80324');
    expect(l).toBeDefined();
    expect(l!.qty).toBe(1);
    expect(l!.supplier).toBe('thunder');
    expect(l!.description).toContain('100 ft needed');
  });

  it('bulbs (80011): ceil((100/2)*1.06) = 53', () => {
    expect(line(bom, '80011')!.qty).toBe(53);
  });

  it('guide wire (80002): 1×250ft spool, needed footage in the description', () => {
    const l = line(bom, '80002');
    expect(l!.qty).toBe(1);
    expect(l!.description).toContain('100 ft needed');
  });

  it('hardware: 2/strand eye screws, quick links, grippers; 1/strand male+female plugs', () => {
    expect(line(bom, '93571')!.qty).toBe(6); // eye screw
    expect(line(bom, '80005')!.qty).toBe(6); // quick link
    expect(line(bom, '80004')!.qty).toBe(6); // gripper
    expect(line(bom, '80308')!.qty).toBe(3); // male plug
    expect(line(bom, '80307')!.qty).toBe(3); // female plug
  });

  it('eye screw carries its confirmed $0.99 unit cost', () => {
    const l = line(bom, '93571')!;
    expect(l.unitCost).toBe(0.99);
    expect(l.extCost).toBe(5.94);
  });

  it('zip wire (80305): as-needed, qty 0, still present as a line', () => {
    const l = line(bom, '80305');
    expect(l).toBeDefined();
    expect(l!.qty).toBe(0);
    expect(l!.asNeeded).toBe(true);
  });

  it('posts + concrete: 1/pole, confirmed costs ($56, $6)', () => {
    const posts = line(bom, '100010238')!;
    const concrete = line(bom, '100321247')!;
    expect(posts.qty).toBe(2);
    expect(posts.unitCost).toBe(56);
    expect(posts.extCost).toBe(112);
    expect(posts.supplier).toBe('home-depot');
    expect(concrete.qty).toBe(2);
    expect(concrete.unitCost).toBe(6);
    expect(concrete.extCost).toBe(12);
  });

  it('timer (B0F5M2S8VJ): 1 per job', () => {
    const l = line(bom, 'B0F5M2S8VJ')!;
    expect(l.qty).toBe(1);
    expect(l.supplier).toBe('amazon');
  });

  it('every line has a matching extCost = round(qty*unitCost)', () => {
    for (const l of bom.lines) {
      expect(l.extCost).toBeCloseTo(Math.round(l.qty * l.unitCost * 100) / 100, 2);
    }
  });

  it('totals: unitsBySupplier + extCostTotal', () => {
    expect(bom.totals.unitsBySupplier).toEqual({ thunder: 5.94, 'home-depot': 124, amazon: 0 });
    expect(bom.totals.extCostTotal).toBe(129.94);
  });

  it('flags the unconfirmed Thunder/Amazon costs', () => {
    expect(bom.flags).toContain(
      'Thunder + Amazon unit costs not confirmed yet — quantities are exact, costs show $0 until set.',
    );
  });
});

describe('buildBistroBom — footage scaling', () => {
  it('340 ft → cord 2 sections, guide wire 2 spools', () => {
    const bom = buildBistroBom(input({ runs: [340] }));
    expect(line(bom, '80324')!.qty).toBe(2);
    expect(line(bom, '80002')!.qty).toBe(2);
  });

  it('33 ft (odd) → bulbs ceil(16.5*1.06) = ceil(17.49) = 18', () => {
    const bom = buildBistroBom(input({ runs: [33] }));
    expect(line(bom, '80011')!.qty).toBe(18);
  });
});

describe('buildBistroBom — poles-only job (no footage)', () => {
  const bom = buildBistroBom(input({ runs: [], poles: 4 }));

  it('posts + concrete + timer present', () => {
    expect(line(bom, '100010238')!.qty).toBe(4);
    expect(line(bom, '100321247')!.qty).toBe(4);
    expect(line(bom, 'B0F5M2S8VJ')!.qty).toBe(1);
  });

  it('NO cord/bulb/wire/strand hardware (no footage, no strands)', () => {
    expect(line(bom, '80324')).toBeUndefined();
    expect(line(bom, '80011')).toBeUndefined();
    expect(line(bom, '80002')).toBeUndefined();
    expect(line(bom, '93571')).toBeUndefined();
    expect(line(bom, '80005')).toBeUndefined();
    expect(line(bom, '80004')).toBeUndefined();
    expect(line(bom, '80308')).toBeUndefined();
    expect(line(bom, '80307')).toBeUndefined();
  });

  it('NO zip line — it is a footage-driven power feed, gated on strands existing', () => {
    expect(line(bom, '80305')).toBeUndefined();
  });

  it('totals reflect zero footage/strands', () => {
    expect(bom.totals.totalFootage).toBe(0);
    expect(bom.totals.strands).toBe(0);
    expect(bom.totals.poles).toBe(4);
  });
});

describe('buildBistroBom — footage-only job (no poles)', () => {
  const bom = buildBistroBom(input({ runs: [50] }));

  it('NO posts/concrete (no poles)', () => {
    expect(line(bom, '100010238')).toBeUndefined();
    expect(line(bom, '100321247')).toBeUndefined();
  });

  it('timer still present — footage alone triggers the per-job timer', () => {
    expect(line(bom, 'B0F5M2S8VJ')!.qty).toBe(1);
  });

  it('zip line present — a strand exists', () => {
    const l = line(bom, '80305')!;
    expect(l.qty).toBe(0);
    expect(l.asNeeded).toBe(true);
  });
});

describe('buildBistroBom — empty job', () => {
  it('no footage, no poles → an empty (not null) BOM: no lines, no timer, no flags', () => {
    const bom = buildBistroBom(input());
    expect(bom.lines).toEqual([]);
    expect(bom.flags).toEqual([]);
    expect(bom.totals).toEqual({
      totalFootage: 0,
      strands: 0,
      poles: 0,
      unitsBySupplier: { thunder: 0, 'home-depot': 0, amazon: 0 },
      extCostTotal: 0,
    });
  });
});

describe('buildBistroBom — costOverrides', () => {
  it('a costOverrides entry replaces the fallback unit cost for that SKU only', () => {
    const overrides = new Map([['80324', 3.25]]);
    const bom = buildBistroBom(input({ runs: WORKED_RUNS, poles: 2 }), overrides);
    const cord = line(bom, '80324')!;
    expect(cord.unitCost).toBe(3.25);
    expect(cord.extCost).toBe(3.25); // qty 1
    // Every other Thunder SKU is still unconfirmed ($0) → the flag still fires.
    expect(bom.flags).toContain(
      'Thunder + Amazon unit costs not confirmed yet — quantities are exact, costs show $0 until set.',
    );
  });

  it('overriding EVERY unconfirmed SKU clears the flag', () => {
    const overrides = new Map([
      ['80324', 1], ['80011', 1], ['80002', 1], ['80005', 1], ['80004', 1],
      ['80308', 1], ['80307', 1], ['80305', 1], ['B0F5M2S8VJ', 1],
    ]);
    const bom = buildBistroBom(input({ runs: WORKED_RUNS, poles: 2 }), overrides);
    expect(bom.flags).toEqual([]);
  });
});

describe('buildBistroBom — runs input guards non-positive/invalid entries', () => {
  it('zero, negative, and NaN entries are dropped from strands/footage', () => {
    const bom = buildBistroBom(input({ runs: [10, 0, -5, NaN, 20] }));
    expect(bom.totals.totalFootage).toBe(30);
    expect(bom.totals.strands).toBe(2);
  });
});
