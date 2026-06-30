import { describe, it, expect } from 'vitest';
import { isUuid } from './validate';

describe('isUuid', () => {
  it('accepts a well-formed uuid (any case)', () => {
    expect(isUuid('8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60')).toBe(true);
    expect(isUuid('8F14E45F-CEEA-467A-9F3A-1B2C3D4E5F60')).toBe(true);
  });
  it('rejects non-uuid strings', () => {
    expect(isUuid('x')).toBe(false);
    expect(isUuid('admin')).toBe(false);
    expect(isUuid('8f14e45f-ceea-467a-9f3a')).toBe(false); // too short
    expect(isUuid('')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
