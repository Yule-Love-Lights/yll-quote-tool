import { describe, it, expect } from 'vitest';
import { extraPhotoLabels, photoLabelForLine } from './photoLabels';

const A = 'aaaa1111-2222-4333-8444-555566667777';
const B = 'bbbb1111-2222-4333-8444-555566667777';

describe('extraPhotoLabels (#13)', () => {
  it('numbers extras from Photo 2 in array order; titles win', () => {
    const m = extraPhotoLabels([
      { id: A, title: null },
      { id: B, title: '  Backyard ' },
    ]);
    expect(m.get(A)).toBe('Photo 2');
    expect(m.get(B)).toBe('Backyard');
  });
  it('handles null/empty', () => {
    expect(extraPhotoLabels(null).size).toBe(0);
    expect(extraPhotoLabels([]).size).toBe(0);
  });
});

describe('photoLabelForLine (#13)', () => {
  const items = [
    { id: 'i1' }, // base photo
    { id: 'i2', photoId: A },
    { id: 'i3', photoId: null },
  ];
  const labels = extraPhotoLabels([{ id: A, title: 'Left side' }]);

  it('tags a line whose scene item sits on an extra photo', () => {
    expect(photoLabelForLine(['i2'], items, labels)).toBe('Left side');
  });
  it('returns null for base-photo lines (untagged = photo 1)', () => {
    expect(photoLabelForLine(['i1'], items, labels)).toBeNull();
    expect(photoLabelForLine(['i3'], items, labels)).toBeNull();
  });
  it('mini groups: any extra-photo member tags the line', () => {
    expect(photoLabelForLine(['i1', 'i2'], items, labels)).toBe('Left side');
  });
  it('null/empty/unknown ids → no tag', () => {
    expect(photoLabelForLine(undefined, items, labels)).toBeNull();
    expect(photoLabelForLine([], items, labels)).toBeNull();
    expect(photoLabelForLine(['nope'], items, labels)).toBeNull();
  });

  it('twins never decide the tag — the canonical\'s photo does (#13 twin-expansion bug)', () => {
    const twinItems = [
      { id: 'canon-base' }, // canonical on photo 1
      { id: 'twin-extra', photoId: A, linkedToId: 'canon-base' }, // its re-placed depiction
      { id: 'canon-extra', photoId: A }, // fresh billable drawn on the extra
      { id: 'twin-base', linkedToId: 'canon-extra' }, // that one's depiction on photo 1
    ];
    // attachSceneLinks expands lines with twin ids — a photo-1 canonical with a
    // Left-side twin must stay UNTAGGED (the Jason CP2 repro)…
    expect(photoLabelForLine(['canon-base', 'twin-extra'], twinItems, labels)).toBeNull();
    // …while a canonical living ON the extra still tags, twins ignored.
    expect(photoLabelForLine(['canon-extra', 'twin-base'], twinItems, labels)).toBe('Left side');
  });
});
