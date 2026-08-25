import { describe, it, expect } from 'vitest';
import { chosenLightColorLabel, chosenLightColorLabelFromSnapshot } from './chosenColorLabel';

describe('chosenLightColorLabel (row 362)', () => {
  it('names the approved scheme', () => {
    expect(chosenLightColorLabel({ colorSchemeId: 'champagne' })).toBe('Champagne');
  });

  it("reads 'as-designed' as the designer's pick rather than as no choice", () => {
    // A real, deliberate choice — it must render, not vanish.
    expect(chosenLightColorLabel({ colorSchemeId: 'as-designed' })).toBe("Staff's pick");
  });

  it('returns null when the quote has no approved selection at all', () => {
    expect(chosenLightColorLabel(undefined)).toBeNull();
    expect(chosenLightColorLabel(null)).toBeNull();
    expect(chosenLightColorLabel({})).toBeNull();
  });

  it('reports a custom pattern as such', () => {
    expect(chosenLightColorLabel({ colorSchemeId: 'custom' })).toBe('Custom pattern');
  });

  it('lets a custom PATTERN win even when the scheme id still names a scheme', () => {
    // Staff hand-picking colours can leave a stale scheme id behind; the
    // pattern is what actually renders, so it must win or the label lies.
    expect(
      chosenLightColorLabel({ colorSchemeId: 'champagne', customPattern: ['red', 'green'] }),
    ).toBe('Custom pattern');
  });

  it('ignores an EMPTY custom pattern', () => {
    expect(
      chosenLightColorLabel({ colorSchemeId: 'champagne', customPattern: [] }),
    ).toBe('Champagne');
  });
});

describe('chosenLightColorLabelFromSnapshot', () => {
  it('digs the selection out of an approval snapshot', () => {
    expect(
      chosenLightColorLabelFromSnapshot({
        amendments: [],
        customerSelection: { colorSchemeId: 'champagne', customPattern: [] },
      }),
    ).toBe('Champagne');
  });

  it('survives every shape a missing or malformed snapshot can take', () => {
    expect(chosenLightColorLabelFromSnapshot(null)).toBeNull();
    expect(chosenLightColorLabelFromSnapshot(undefined)).toBeNull();
    expect(chosenLightColorLabelFromSnapshot('not an object')).toBeNull();
    expect(chosenLightColorLabelFromSnapshot({})).toBeNull();
    expect(chosenLightColorLabelFromSnapshot({ customerSelection: null })).toBeNull();
  });

  it('matches Kristie #1129 after the row-362 correction', () => {
    // The real shape her booked quote now carries.
    expect(
      chosenLightColorLabelFromSnapshot({
        customerSelection: {
          colorSchemeId: 'champagne',
          customPattern: [],
          colorIds: ['warm-white', 'cool-white'],
        },
      }),
    ).toBe('Champagne');
  });
});
