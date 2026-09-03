// Perceptual photo hashing for duplicate-flag assistance (Naldo 2026-08-29:
// "work on the photo similarity"). dHash: 9x8 grayscale, each bit = "is this
// pixel brighter than its right neighbor", 64 bits as 16 hex chars. Similar
// photos differ in few bits; the flag threshold is deliberately strict so it
// stays a HINT for admin, never an auto-verdict.

import { describe, expect, it } from 'vitest';

import { dHashFromGray9x8, hammingDistanceHex, isSimilarPhotoHash } from './photoHash';

function gray(fn: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(72);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) px[y * 9 + x] = fn(x, y);
  return px;
}

describe('dHashFromGray9x8', () => {
  it('produces 16 hex chars and is deterministic', () => {
    const px = gray((x, y) => (x * 20 + y * 5) % 256);
    const h1 = dHashFromGray9x8(px);
    const h2 = dHashFromGray9x8(px);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).toBe(h2);
  });

  it('identical images hash identically; an inverted image is maximally different', () => {
    const px = gray((x) => (x % 2 === 0 ? 200 : 50));
    const inverted = gray((x) => (x % 2 === 0 ? 50 : 200));
    const a = dHashFromGray9x8(px);
    const b = dHashFromGray9x8(inverted);
    expect(hammingDistanceHex(a, a)).toBe(0);
    expect(hammingDistanceHex(a, b)).toBe(64);
  });

  it('a small brightness shift leaves the hash nearly unchanged (gradient survives re-exposure)', () => {
    const px = gray((x, y) => Math.min(255, x * 25 + y * 3));
    const brighter = gray((x, y) => Math.min(255, x * 25 + y * 3 + 30));
    const d = hammingDistanceHex(dHashFromGray9x8(px), dHashFromGray9x8(brighter));
    expect(d).toBeLessThanOrEqual(6);
  });

  it('refuses wrong-sized input loudly', () => {
    expect(() => dHashFromGray9x8(new Uint8Array(64))).toThrow(/72/);
  });
});

describe('isSimilarPhotoHash', () => {
  it('flags at the strict threshold and not past it', () => {
    const base = '0000000000000000';
    expect(isSimilarPhotoHash(base, base)).toBe(true); // distance 0
    expect(isSimilarPhotoHash(base, '000000000000000f')).toBe(true); // 4 bits
    expect(isSimilarPhotoHash(base, '00000000000003ff')).toBe(true); // 10 bits
    expect(isSimilarPhotoHash(base, '00000000000007ff')).toBe(false); // 11 bits
    expect(isSimilarPhotoHash(base, 'ffffffffffffffff')).toBe(false);
  });

  it('a missing hash on either side is never similar (no signal, no flag)', () => {
    expect(isSimilarPhotoHash(null, '0000000000000000')).toBe(false);
    expect(isSimilarPhotoHash('0000000000000000', null)).toBe(false);
    expect(isSimilarPhotoHash(null, null)).toBe(false);
    expect(isSimilarPhotoHash('zznotahash000000', '0000000000000000')).toBe(false);
  });
});
