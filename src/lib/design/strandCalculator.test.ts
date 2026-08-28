import { describe, it, expect } from 'vitest';
import {
  roundCanopyFootage,
  squareHedgeFootage,
  roundColumnGarlandFootage,
  squareColumnGarlandFootage,
  spruceWrapFootage,
  spruceBulbCount,
  footageToMiniStrands,
  footageToGarlandSticks,
  calculateFootage,
  type StrandCalculatorInput,
} from './strandCalculator';

// All expected values below are computed BY HAND (arithmetic shown in each
// comment), never by running this module — per the brief, that would prove
// nothing. Two are the company sheet's own worked examples.

describe('roundCanopyFootage (model 1 — round bush/tree canopy)', () => {
  it('matches the sheet\'s worked example: 480in tall, 84in circumference, 6in spacing → 560ft', () => {
    // wraps = 480 / 6 = 80
    // footage = (80 * 84) / 12 = 6720 / 12 = 560
    expect(roundCanopyFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: 6 })).toBe(560);
  });

  it('does not round the intermediate wraps before computing footage', () => {
    // wraps = 100 / 6 = 16.6666... (NOT rounded to 17)
    // footage = (16.6666... * 60) / 12 = 1000 / 12 = 83.3333...
    // If wraps were rounded to 17 first, footage would be (17*60)/12 = 85 —
    // asserting the unrounded value proves that did not happen.
    const footage = roundCanopyFootage({ heightIn: 100, circumferenceIn: 60, spacingIn: 6 });
    expect(footage).toBeCloseTo(83.333333, 5);
    expect(footage).not.toBe(85);
  });

  it('returns a real zero for a zero-height plant (not null — this is a valid measurement)', () => {
    expect(roundCanopyFootage({ heightIn: 0, circumferenceIn: 84, spacingIn: 6 })).toBe(0);
  });

  it('returns null for zero spacing (division by zero, cannot compute)', () => {
    expect(roundCanopyFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: 0 })).toBeNull();
  });

  it('returns null for negative spacing', () => {
    expect(roundCanopyFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: -6 })).toBeNull();
  });

  it('returns null for a negative dimension (physically invalid, not a real zero)', () => {
    expect(roundCanopyFootage({ heightIn: -10, circumferenceIn: 84, spacingIn: 6 })).toBeNull();
    expect(roundCanopyFootage({ heightIn: 480, circumferenceIn: -84, spacingIn: 6 })).toBeNull();
  });

  it('returns null for non-finite inputs (NaN, Infinity)', () => {
    expect(roundCanopyFootage({ heightIn: NaN, circumferenceIn: 84, spacingIn: 6 })).toBeNull();
    expect(roundCanopyFootage({ heightIn: Infinity, circumferenceIn: 84, spacingIn: 6 })).toBeNull();
    expect(roundCanopyFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: NaN })).toBeNull();
  });

  it('returns null (never Infinity) when absurdly large finite inputs overflow', () => {
    const result = roundCanopyFootage({ heightIn: 1e200, circumferenceIn: 1e200, spacingIn: 6 });
    expect(result).toBeNull();
  });
});

describe('squareHedgeFootage (model 2 — square hedge canopy)', () => {
  it('matches the sheet\'s worked example: 36in tall, 24in wide, 30in deep, 4in spacing → 84ft', () => {
    // perimeterRun = (24 + 30) * 2 = 108
    // footage = (108 * (36/4) + 36) / 12 = (108*9 + 36) / 12 = (972+36)/12 = 1008/12 = 84
    expect(squareHedgeFootage({ heightIn: 36, widthIn: 24, lengthIn: 30, spacingIn: 4 })).toBe(84);
  });

  it('matches an independent hand-computed fixture (asymmetric width/length)', () => {
    // perimeterRun = (10 + 5) * 2 = 30
    // height/spacing = 48/8 = 6
    // footage = (30*6 + 48) / 12 = (180+48)/12 = 228/12 = 19
    expect(squareHedgeFootage({ heightIn: 48, widthIn: 10, lengthIn: 5, spacingIn: 8 })).toBe(19);
  });

  it('returns a real zero when height is zero', () => {
    expect(squareHedgeFootage({ heightIn: 0, widthIn: 24, lengthIn: 30, spacingIn: 4 })).toBe(0);
  });

  it('returns null for zero or negative spacing', () => {
    expect(squareHedgeFootage({ heightIn: 36, widthIn: 24, lengthIn: 30, spacingIn: 0 })).toBeNull();
    expect(squareHedgeFootage({ heightIn: 36, widthIn: 24, lengthIn: 30, spacingIn: -4 })).toBeNull();
  });

  it('returns null for a negative dimension', () => {
    expect(squareHedgeFootage({ heightIn: 36, widthIn: -24, lengthIn: 30, spacingIn: 4 })).toBeNull();
    expect(squareHedgeFootage({ heightIn: 36, widthIn: 24, lengthIn: -30, spacingIn: 4 })).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(squareHedgeFootage({ heightIn: 36, widthIn: 24, lengthIn: Infinity, spacingIn: 4 })).toBeNull();
  });

  it('returns null (never Infinity) when absurdly large finite inputs overflow', () => {
    expect(squareHedgeFootage({ heightIn: 1e200, widthIn: 1e200, lengthIn: 1e200, spacingIn: 4 })).toBeNull();
  });
});

describe('roundColumnGarlandFootage (model 3 — round column garland)', () => {
  it('matches an independent hand-computed fixture', () => {
    // wraps-term = 84/6 + 1 = 14 + 1 = 15
    // footage = (30*15 + 84) / 12 = (450+84)/12 = 534/12 = 44.5
    expect(roundColumnGarlandFootage({ heightIn: 84, circumferenceIn: 30, spacingIn: 6 })).toBe(44.5);
  });

  it('the +1 extra wrap and trailing +height distinguish this from model 1 on identical inputs', () => {
    // Same height/circumference/spacing as the model-1 worked example
    // (480/84/6 → model 1 gives 560), but this model's formula must NOT
    // collapse to the same number — proves the +1 and +height terms fire.
    const canopy = roundCanopyFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: 6 });
    const garland = roundColumnGarlandFootage({ heightIn: 480, circumferenceIn: 84, spacingIn: 6 });
    expect(canopy).toBe(560);
    // wraps-term = 480/6 + 1 = 81; footage = (84*81 + 480)/12 = (6804+480)/12 = 7284/12 = 607
    expect(garland).toBe(607);
    expect(garland).not.toBe(canopy);
  });

  it('returns a real zero when height is zero (still carries the +1 wrap, but no vertical run)', () => {
    // wraps-term = 0/6 + 1 = 1; footage = (30*1 + 0)/12 = 30/12 = 2.5 — a real
    // positive number for a zero-height column, since the "+1" wrap and the
    // circumference alone still produce a nonzero result. Not degenerate.
    expect(roundColumnGarlandFootage({ heightIn: 0, circumferenceIn: 30, spacingIn: 6 })).toBe(2.5);
  });

  it('returns null for zero or negative spacing', () => {
    expect(roundColumnGarlandFootage({ heightIn: 84, circumferenceIn: 30, spacingIn: 0 })).toBeNull();
    expect(roundColumnGarlandFootage({ heightIn: 84, circumferenceIn: 30, spacingIn: -6 })).toBeNull();
  });

  it('returns null for a negative dimension or non-finite input', () => {
    expect(roundColumnGarlandFootage({ heightIn: -84, circumferenceIn: 30, spacingIn: 6 })).toBeNull();
    expect(roundColumnGarlandFootage({ heightIn: 84, circumferenceIn: NaN, spacingIn: 6 })).toBeNull();
  });
});

describe('squareColumnGarlandFootage (model 4 — square column garland)', () => {
  it('matches an independent hand-computed fixture', () => {
    // perimeterRun = (10+5)*2 = 30
    // wraps-term = 60/5 + 1 = 12 + 1 = 13
    // footage = (30*13 + 60) / 12 = (390+60)/12 = 450/12 = 37.5
    expect(squareColumnGarlandFootage({ heightIn: 60, lengthIn: 10, widthIn: 5, spacingIn: 5 })).toBe(37.5);
  });

  it('returns null for zero or negative spacing', () => {
    expect(squareColumnGarlandFootage({ heightIn: 60, lengthIn: 10, widthIn: 5, spacingIn: 0 })).toBeNull();
    expect(squareColumnGarlandFootage({ heightIn: 60, lengthIn: 10, widthIn: 5, spacingIn: -5 })).toBeNull();
  });

  it('returns null for a negative dimension or non-finite input', () => {
    expect(squareColumnGarlandFootage({ heightIn: 60, lengthIn: -10, widthIn: 5, spacingIn: 5 })).toBeNull();
    expect(squareColumnGarlandFootage({ heightIn: 60, lengthIn: 10, widthIn: Infinity, spacingIn: 5 })).toBeNull();
  });
});

describe('spruceWrapFootage (model 5 — spruce tree wrap, C7/C9)', () => {
  it('matches an independent hand-computed fixture, cross-checked two ways', () => {
    // heightIn = 10*12 = 120
    // circumferenceIn = (4 * 3.14159) * 12 = 12.56636 * 12 = 150.79632
    // wraps = 120 / 12 = 10
    // bottomIn = 10 * 0.45 * 150.79632 = 4.5 * 150.79632 = 678.58344
    // topIn = 10 * 0.38 * (0.3 * 150.79632) = 3.8 * 45.238896 = 171.9078048
    // footage = (678.58344 + 171.9078048) / 12 = 850.4912448 / 12 = 70.8742704
    //
    // Cross-check via algebraic regrouping (bottomIn+topIn factors to
    // wraps*circumferenceIn*(0.45 + 0.38*0.3) = wraps*circumferenceIn*0.564):
    // 10 * 150.79632 * 0.564 / 12 = 1507.9632 * 0.564 / 12 = 850.49124...  / 12
    // = 70.8742704 — matches.
    const footage = spruceWrapFootage({ heightFt: 10, diameterFt: 4, wrapSpacingIn: 12 });
    expect(footage).toBeCloseTo(70.8742704, 5);
  });

  it('returns a real zero when height is zero', () => {
    expect(spruceWrapFootage({ heightFt: 0, diameterFt: 4, wrapSpacingIn: 12 })).toBe(0);
  });

  it('returns null for zero or negative wrap spacing', () => {
    expect(spruceWrapFootage({ heightFt: 10, diameterFt: 4, wrapSpacingIn: 0 })).toBeNull();
    expect(spruceWrapFootage({ heightFt: 10, diameterFt: 4, wrapSpacingIn: -12 })).toBeNull();
  });

  it('returns null for a negative dimension or non-finite input', () => {
    expect(spruceWrapFootage({ heightFt: -10, diameterFt: 4, wrapSpacingIn: 12 })).toBeNull();
    expect(spruceWrapFootage({ heightFt: 10, diameterFt: NaN, wrapSpacingIn: 12 })).toBeNull();
  });

  it('returns null (never Infinity) when absurdly large finite inputs overflow', () => {
    expect(spruceWrapFootage({ heightFt: 1e200, diameterFt: 1e200, wrapSpacingIn: 12 })).toBeNull();
  });
});

describe('spruceBulbCount (footage → C7/C9 bulb count by spacing)', () => {
  it('matches the sheet\'s four named factors exactly, for a clean 100ft fixture', () => {
    expect(spruceBulbCount(100, 12)).toBe(100); // factor 1
    expect(spruceBulbCount(100, 15)).toBe(80); // factor 0.8
    expect(spruceBulbCount(100, 18)).toBeCloseTo(66.66, 10); // factor 0.6666
    expect(spruceBulbCount(100, 24)).toBe(50); // factor 0.5
  });

  it('returns a real zero for zero footage', () => {
    expect(spruceBulbCount(0, 12)).toBe(0);
  });

  it('returns null for negative or non-finite footage', () => {
    expect(spruceBulbCount(-100, 12)).toBeNull();
    expect(spruceBulbCount(NaN, 12)).toBeNull();
  });

  it('returns null for a bulb spacing the sheet does not define a factor for', () => {
    expect(spruceBulbCount(100, 20 as unknown as 12)).toBeNull();
  });
});

describe('footageToMiniStrands (footage → mini-strand count)', () => {
  it('matches the sheet\'s worked example strand counts exactly', () => {
    expect(footageToMiniStrands(560, 6)).toBe(22.4); // 560/25, model-1 example
    expect(footageToMiniStrands(84, 6)).toBe(3.36); // 84/25, model-2 example
    expect(footageToMiniStrands(84, 4)).toBeCloseTo(4.941176470588235, 12); // 84/17, model-2 example
  });

  it('defaults to 6in spacing (the confirmed company standard) when unspecified', () => {
    expect(footageToMiniStrands(560)).toBe(footageToMiniStrands(560, 6));
  });

  it('4in spacing under-counts by ~1.47x if the 25ft (6in) figure is used instead', () => {
    const at6 = footageToMiniStrands(84, 6)!;
    const at4 = footageToMiniStrands(84, 4)!;
    expect(at4 / at6).toBeCloseTo(25 / 17, 10);
  });

  it('returns a real zero for zero footage', () => {
    expect(footageToMiniStrands(0)).toBe(0);
  });

  it('returns null for negative or non-finite footage', () => {
    expect(footageToMiniStrands(-10)).toBeNull();
    expect(footageToMiniStrands(Infinity)).toBeNull();
  });

  it('returns null for an unsupported bulb spacing', () => {
    expect(footageToMiniStrands(100, 5 as unknown as 6)).toBeNull();
  });
});

describe('footageToGarlandSticks (footage → 9ft garland sticks)', () => {
  it('matches a clean hand-computed fixture', () => {
    expect(footageToGarlandSticks(45)).toBe(5); // 45/9
  });

  it('returns a real zero for zero footage', () => {
    expect(footageToGarlandSticks(0)).toBe(0);
  });

  it('returns null for negative or non-finite footage', () => {
    expect(footageToGarlandSticks(-9)).toBeNull();
    expect(footageToGarlandSticks(NaN)).toBeNull();
  });
});

describe('calculateFootage (dispatcher)', () => {
  const cases: Array<{ input: StrandCalculatorInput; expected: number }> = [
    { input: { model: 'roundCanopy', heightIn: 480, circumferenceIn: 84, spacingIn: 6 }, expected: 560 },
    { input: { model: 'squareHedge', heightIn: 36, widthIn: 24, lengthIn: 30, spacingIn: 4 }, expected: 84 },
    { input: { model: 'roundColumnGarland', heightIn: 84, circumferenceIn: 30, spacingIn: 6 }, expected: 44.5 },
    { input: { model: 'squareColumnGarland', heightIn: 60, lengthIn: 10, widthIn: 5, spacingIn: 5 }, expected: 37.5 },
  ];

  it.each(cases)('dispatches $input.model to the matching model function', ({ input, expected }) => {
    expect(calculateFootage(input)).toBe(expected);
  });

  it('dispatches spruceWrap to spruceWrapFootage', () => {
    const viaDispatcher = calculateFootage({ model: 'spruceWrap', heightFt: 10, diameterFt: 4, wrapSpacingIn: 12 });
    const direct = spruceWrapFootage({ heightFt: 10, diameterFt: 4, wrapSpacingIn: 12 });
    expect(viaDispatcher).toBe(direct);
  });

  it('returns null for an unrecognized model at runtime (defensive default)', () => {
    const bogus = { model: 'not-a-real-model' } as unknown as StrandCalculatorInput;
    expect(calculateFootage(bogus)).toBeNull();
  });
});
