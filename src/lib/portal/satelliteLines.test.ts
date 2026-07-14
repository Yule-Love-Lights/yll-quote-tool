import { describe, it, expect } from 'vitest';
import { selectDrawableLineGroups } from './satelliteLines';
import type { PortalSatelliteLines } from '@/components/portal/types';

const line = (n: number): { points: [number, number][]; label: string } => ({
  points: Array.from({ length: n }, (_, i) => [i / 10, i / 10] as [number, number]),
  label: '',
});

const empty: PortalSatelliteLines = { santas: [], gingerbread: [], c9: [] };

describe('selectDrawableLineGroups (#51)', () => {
  it('returns [] for null / undefined / all-empty lines', () => {
    expect(selectDrawableLineGroups(null)).toEqual([]);
    expect(selectDrawableLineGroups(undefined)).toEqual([]);
    expect(selectDrawableLineGroups(empty)).toEqual([]);
  });

  it('drops a group whose only polyline has fewer than 2 points', () => {
    const lines: PortalSatelliteLines = { ...empty, santas: [line(1)] };
    expect(selectDrawableLineGroups(lines)).toEqual([]);
  });

  it('keeps a group with a >= 2-point polyline', () => {
    const lines: PortalSatelliteLines = { ...empty, santas: [line(2)] };
    const groups = selectDrawableLineGroups(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('santas');
    expect(groups[0].color).toBe('#ef4444');
    expect(groups[0].lines).toHaveLength(1);
  });

  it('filters out the sub-2-point lines within a kept group', () => {
    const lines: PortalSatelliteLines = { ...empty, gingerbread: [line(1), line(3), line(0)] };
    const groups = selectDrawableLineGroups(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].lines).toHaveLength(1); // only the 3-point line survives
  });

  it('returns the drawable groups in santas -> gingerbread -> c9 order', () => {
    const lines: PortalSatelliteLines = {
      santas: [line(2)],
      gingerbread: [line(2)],
      c9: [line(2)],
    };
    expect(selectDrawableLineGroups(lines).map((g) => g.key)).toEqual([
      'santas',
      'gingerbread',
      'c9',
    ]);
  });

  it('includes the stake group (purple) after c9 when it has lines', () => {
    const lines: PortalSatelliteLines = { ...empty, stake: [line(2)] };
    const groups = selectDrawableLineGroups(lines);
    const stake = groups.find((g) => g.key === 'stake');
    expect(stake).toBeTruthy();
    expect(stake!.color).toBe('#a855f7');
    expect(stake!.label).toBe('Stake Lighting');
    // render order: santas -> gingerbread -> c9 -> stake
    expect(selectDrawableLineGroups({ ...empty, santas: [line(2)], c9: [line(2)], stake: [line(2)] }).map((g) => g.key))
      .toEqual(['santas', 'c9', 'stake']);
  });

  it('tolerates a missing line-group key (treats it as empty)', () => {
    // A malformed row from the DB may omit a key entirely.
    const lines = { santas: [line(2)] } as unknown as PortalSatelliteLines;
    const groups = selectDrawableLineGroups(lines);
    expect(groups.map((g) => g.key)).toEqual(['santas']);
  });

  it('with no allowedKeys arg, returns every drawable group (holiday/event unchanged)', () => {
    const lines: PortalSatelliteLines = { santas: [line(2)], gingerbread: [line(2)], c9: [line(2)] };
    expect(selectDrawableLineGroups(lines).map((g) => g.key)).toEqual(['santas', 'gingerbread', 'c9']);
    expect(selectDrawableLineGroups(lines, undefined).map((g) => g.key)).toEqual(['santas', 'gingerbread', 'c9']);
  });

  it('allowedKeys restricts the returned groups to only those keys', () => {
    const lines: PortalSatelliteLines = { santas: [line(2)], gingerbread: [line(2)], c9: [line(2)] };
    expect(selectDrawableLineGroups(lines, ['santas']).map((g) => g.key)).toEqual(['santas']);
    expect(selectDrawableLineGroups(lines, ['gingerbread']).map((g) => g.key)).toEqual(['gingerbread']);
    expect(selectDrawableLineGroups(lines, []).map((g) => g.key)).toEqual([]);
  });

  it('labelOverrides remaps a group label (e.g. permanent "Front of House")', () => {
    const lines: PortalSatelliteLines = { ...empty, santas: [line(2)], gingerbread: [line(2)] };
    const groups = selectDrawableLineGroups(lines, undefined, { santas: 'Front of House', gingerbread: 'Sides' });
    expect(groups.find((g) => g.key === 'santas')!.label).toBe('Front of House');
    expect(groups.find((g) => g.key === 'gingerbread')!.label).toBe('Sides');
  });

  it('omitting labelOverrides keeps the default labels (holiday/event unchanged)', () => {
    const lines: PortalSatelliteLines = { ...empty, santas: [line(2)], gingerbread: [line(2)] };
    const groups = selectDrawableLineGroups(lines, undefined, undefined);
    expect(groups.find((g) => g.key === 'santas')!.label).toBe('Santa Roofline');
    expect(groups.find((g) => g.key === 'gingerbread')!.label).toBe('Gingerbread');
    expect(selectDrawableLineGroups(lines).find((g) => g.key === 'santas')!.label).toBe('Santa Roofline');
  });

  it('labels the c9 channel "Winter Wonderland" — the product it bills as (#136)', () => {
    const lines: PortalSatelliteLines = { ...empty, c9: [line(2)] };
    expect(selectDrawableLineGroups(lines).find((g) => g.key === 'c9')!.label).toBe('Winter Wonderland');
  });
});

describe('selectDrawableLineGroups — permanent side channels (#88 / S23)', () => {
  it('draws front/left/right/back as their own labeled, colored groups', () => {
    const lines: PortalSatelliteLines = {
      santas: [], gingerbread: [], c9: [],
      front: [line(2)], left: [line(2)], right: [line(2)], back: [line(2)],
    };
    const groups = selectDrawableLineGroups(lines, ['front', 'left', 'right', 'back']);
    expect(groups.map((g) => g.key)).toEqual(['front', 'left', 'right', 'back']);
    expect(groups.map((g) => g.label)).toEqual([
      'Front of House',
      'Left Side',
      'Right Side',
      'Back of House',
    ]);
  });

  it('hides a permanent side with no drawn line (only traced sides show)', () => {
    const lines: PortalSatelliteLines = {
      santas: [], gingerbread: [], c9: [],
      front: [line(2)], left: [], right: [], back: [],
    };
    const groups = selectDrawableLineGroups(lines, ['front', 'left', 'right', 'back']);
    expect(groups.map((g) => g.key)).toEqual(['front']);
  });
});

describe('selectDrawableLineGroups — permanent bistro channel (#117)', () => {
  it('draws bistro as its own teal-colored, labeled group', () => {
    const lines: PortalSatelliteLines = { ...empty, bistro: [line(2)] };
    const groups = selectDrawableLineGroups(lines, ['bistro']);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('bistro');
    expect(groups[0].color).toBe('#14b8a6');
    expect(groups[0].label).toBe('Bistro Lights');
  });

  it('hides the bistro group when it has no drawn lines', () => {
    const groups = selectDrawableLineGroups(empty, ['bistro']);
    expect(groups).toEqual([]);
  });

  it('an allowedKeys of ["bistro"] never surfaces the other channels', () => {
    const lines: PortalSatelliteLines = {
      santas: [line(2)], gingerbread: [line(2)], c9: [line(2)],
      front: [line(2)], left: [line(2)], right: [line(2)], back: [line(2)],
      bistro: [line(2)],
    };
    const groups = selectDrawableLineGroups(lines, ['bistro']);
    expect(groups.map((g) => g.key)).toEqual(['bistro']);
  });
});
