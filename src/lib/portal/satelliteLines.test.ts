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
});
