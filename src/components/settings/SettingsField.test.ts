import { describe, it, expect } from 'vitest';
import { spacingSelectOptions } from './SettingsField';

// #223: Settings trimmed its decor/pole size dropdowns down to the editor's
// 3 presets (#202). These tests lock the fallback that keeps an
// already-saved staff default selectable when its option was dropped.
describe('spacingSelectOptions', () => {
  it('returns the preset list unchanged when the value is one of the presets', () => {
    expect(spacingSelectOptions([24, 36, 60], 36)).toEqual([24, 36, 60]);
  });

  it('appends a trailing entry for a legacy value the trim dropped (#202 wreath 48")', () => {
    expect(spacingSelectOptions([24, 36, 60], 48)).toEqual([24, 36, 60, 48]);
  });

  it('does not mutate the passed-in options array', () => {
    const options = [24, 36, 60];
    spacingSelectOptions(options, 48);
    expect(options).toEqual([24, 36, 60]);
  });

  it('appends nothing extra when the value already equals every preset checked in turn', () => {
    for (const v of [24, 36, 60]) {
      expect(spacingSelectOptions([24, 36, 60], v)).toHaveLength(3);
    }
  });
});
