import { describe, expect, it } from 'vitest';

import { describeUnderBilledMiniGroups, findUnderBilledMiniGroups } from './miniGroupBilledCheck';
import type { MiniAreaItem, MiniGroupItem, Scene, StrandItem } from './sceneTypes';

const strand = (id: string, groupId?: string): StrandItem => ({
  id, yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
  drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 10, 10],
  ...(groupId ? { groupId } : {}),
} as StrandItem);

const area = (id: string, groupId?: string): MiniAreaItem => ({
  id, yardstickId: null, kind: 'miniArea', shape: 'box',
  ...(groupId ? { groupId } : {}),
} as MiniAreaItem);

const group = (id: string, memberIds: string[], stringCount?: number): MiniGroupItem => ({
  id, yardstickId: null, kind: 'miniGroup', memberIds, surface: 'railing',
  ...(stringCount === undefined ? {} : { stringCount }),
} as MiniGroupItem);

const scene = (items: unknown[]): Scene => ({ yardsticks: [], items } as unknown as Scene);

describe('findUnderBilledMiniGroups', () => {
  it('flags a group billing fewer strings than it has drawn members', () => {
    const s = scene([
      group('g1', ['a', 'b', 'c'], 1),
      strand('a', 'g1'), strand('b', 'g1'), area('c', 'g1'),
    ]);
    expect(findUnderBilledMiniGroups(s)).toEqual([
      { groupId: 'g1', surface: 'railing', billed: 1, drawn: 3 },
    ]);
  });

  it('does NOT flag a group billing MORE than is drawn, which is a normal staff call', () => {
    const s = scene([group('g1', ['a'], 8), strand('a', 'g1')]);
    expect(findUnderBilledMiniGroups(s)).toEqual([]);
  });

  it('does not flag when billed and drawn agree', () => {
    const s = scene([group('g1', ['a', 'b'], 2), strand('a', 'g1'), strand('b', 'g1')]);
    expect(findUnderBilledMiniGroups(s)).toEqual([]);
  });

  // An orphaned memberId (its item deleted on another photo) must not inflate
  // the drawn count and warn about lights nobody can see.
  it('counts LIVE members only, ignoring orphaned member ids', () => {
    const s = scene([group('g1', ['a', 'gone'], 1), strand('a', 'g1')]);
    expect(findUnderBilledMiniGroups(s)).toEqual([]);
  });

  it('ignores an item that claims the group but is not in memberIds', () => {
    const s = scene([group('g1', ['a'], 1), strand('a', 'g1'), strand('stray', 'g1')]);
    expect(findUnderBilledMiniGroups(s)).toEqual([]);
  });

  it('treats a missing stringCount as the billed default of 1', () => {
    const s = scene([group('g1', ['a', 'b']), strand('a', 'g1'), strand('b', 'g1')]);
    expect(findUnderBilledMiniGroups(s)[0]).toMatchObject({ billed: 1, drawn: 2 });
  });

  it('is empty for a scene with no groups, and safe on null', () => {
    expect(findUnderBilledMiniGroups(scene([strand('a')]))).toEqual([]);
    expect(findUnderBilledMiniGroups(null)).toEqual([]);
    expect(findUnderBilledMiniGroups(undefined)).toEqual([]);
  });
});

describe('describeUnderBilledMiniGroups', () => {
  it('names the totals and says plainly that the design is a reference', () => {
    const msg = describeUnderBilledMiniGroups([
      { groupId: 'g1', surface: 'railing', billed: 1, drawn: 3 },
      { groupId: 'g2', surface: 'curtain', billed: 2, drawn: 4 },
    ]);
    expect(msg).toContain('2 mini-light groups');
    expect(msg).toContain('4 unbilled in total'); // (3-1) + (4-2)
    expect(msg).toContain('railing group billing 1 for 3 drawn');
    expect(msg).toContain('reference');
  });
});
