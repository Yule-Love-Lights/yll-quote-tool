import { describe, it, expect } from 'vitest';
import { isItemOnPhoto } from './sceneTypes';

// #13 multi-image: the one predicate both the editor's per-photo filtering and
// the portal's per-photo rendering hang off. null/absent photoId = the BASE
// photo on both sides.

describe('isItemOnPhoto (#13)', () => {
  const P1 = 'aaaa1111-2222-4333-8444-555566667777';

  it('legacy items (no photoId) belong to the base mount only', () => {
    expect(isItemOnPhoto({}, null)).toBe(true);
    expect(isItemOnPhoto({ photoId: undefined }, null)).toBe(true);
    expect(isItemOnPhoto({ photoId: null }, null)).toBe(true);
    expect(isItemOnPhoto({}, P1)).toBe(false);
    expect(isItemOnPhoto({ photoId: null }, P1)).toBe(false);
  });

  it('stamped items belong to their photo only', () => {
    expect(isItemOnPhoto({ photoId: P1 }, P1)).toBe(true);
    expect(isItemOnPhoto({ photoId: P1 }, null)).toBe(false);
    expect(isItemOnPhoto({ photoId: P1 }, 'other-id')).toBe(false);
  });
});
