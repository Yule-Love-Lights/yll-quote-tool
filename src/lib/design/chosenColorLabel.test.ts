import { describe, it, expect } from 'vitest';
import { chosenLightColorLabel } from './chosenColorLabel';
import { PERMANENT_SWATCH_SCHEMES } from './permanentScenes';
import { DEFAULT_COLOR_SCHEMES } from './colorSchemes';

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

describe('vertical resolution (premerge HIGH — the wrong list renders a CONFIDENTLY WRONG colour)', () => {
  // Permanent and holiday freeze into DISJOINT id spaces, and getColorScheme
  // does not report a miss: an unknown id silently becomes as-designed, whose
  // label is "Staff's pick". So the failure is not a blank or an error — it is
  // a plausible-looking wrong answer on the screen the crew builds from.
  it('names a permanent colour when resolved against the PERMANENT list', () => {
    expect(chosenLightColorLabel({ colorSchemeId: 'orange' }, PERMANENT_SWATCH_SCHEMES)).toBe('Orange');
    expect(chosenLightColorLabel({ colorSchemeId: 'rainbow' }, PERMANENT_SWATCH_SCHEMES)).toBe('Rainbow');
    expect(chosenLightColorLabel({ colorSchemeId: 'patriotic' }, PERMANENT_SWATCH_SCHEMES)).toBe('Red · White · Blue');
  });

  it("REGRESSION: a permanent colour against the holiday list degrades to \"Staff's pick\"", () => {
    // This is the live defect the lens found, pinned so it cannot come back.
    // Booked permanent quote #1303 approved 'orange'; against the holiday list
    // the job page would have told the crew "Staff's pick".
    expect(chosenLightColorLabel({ colorSchemeId: 'orange' }, DEFAULT_COLOR_SCHEMES)).toBe("Staff's pick");
    // ...which is why callers must pass the vertical's own list.
    expect(chosenLightColorLabel({ colorSchemeId: 'orange' }, PERMANENT_SWATCH_SCHEMES)).not.toBe("Staff's pick");
  });

  it('still resolves holiday schemes against the holiday list', () => {
    expect(chosenLightColorLabel({ colorSchemeId: 'champagne' }, DEFAULT_COLOR_SCHEMES)).toBe('Champagne');
  });

  it('resolves a staff-customised swatch when it is in the passed list', () => {
    // app_settings lets staff add swatches without a deploy; passing the LIVE
    // list is what makes those resolve instead of degrading.
    const custom = [...DEFAULT_COLOR_SCHEMES, { id: 'naldo-special', label: 'Naldo Special', colorIds: ['red'] }];
    expect(chosenLightColorLabel({ colorSchemeId: 'naldo-special' }, custom)).toBe('Naldo Special');
    expect(chosenLightColorLabel({ colorSchemeId: 'naldo-special' }, DEFAULT_COLOR_SCHEMES)).toBe("Staff's pick");
  });
});
