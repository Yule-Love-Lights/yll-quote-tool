import { describe, expect, it } from 'vitest';
import { resolvePortalImageVisibility } from './imageVisibility';

describe('resolvePortalImageVisibility', () => {
  it.each([
    [true, true, 'both'],
    [true, false, 'street-only'],
    [false, true, 'satellite-only'],
    [false, false, 'neither'],
  ] as const)('maps street=%s satellite=%s to %s', (street, satellite, state) => {
    expect(resolvePortalImageVisibility(street, satellite)).toEqual({
      state,
      street,
      satellite,
    });
  });
});
