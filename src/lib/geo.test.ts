import { describe, it, expect } from 'vitest';
import { bearingBetween, destinationPoint } from './geo';

describe('bearingBetween', () => {
  it('points north for a due-north target', () => {
    expect(bearingBetween(0, 0, 1, 0)).toBeCloseTo(0, 5);
  });
  it('points east (90°) for a due-east target', () => {
    expect(bearingBetween(0, 0, 0, 1)).toBeCloseTo(90, 5);
  });
  it('points south (180°) and west (270°)', () => {
    expect(bearingBetween(0, 0, -1, 0)).toBeCloseTo(180, 5);
    expect(bearingBetween(0, 0, 0, -1)).toBeCloseTo(270, 5);
  });
  it('returns a value in [0, 360)', () => {
    const b = bearingBetween(40.1, -74.2, 40.0, -74.3);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('destinationPoint', () => {
  it('moves ~1° of longitude east near the equator', () => {
    // ~111.32 km ≈ 1° of longitude at the equator.
    const d = destinationPoint(0, 0, 90, 111_320);
    expect(d.lat).toBeCloseTo(0, 3);
    expect(d.lng).toBeCloseTo(1, 2);
  });
  it('moves north for bearing 0', () => {
    const d = destinationPoint(40, -74, 0, 111_320);
    expect(d.lat).toBeGreaterThan(40);
    expect(d.lng).toBeCloseTo(-74, 3);
  });
  it('round-trips: stepping out then measuring the bearing back is the reverse', () => {
    const start = { lat: 40.0, lng: -74.0 };
    const bearing = 75;
    const d = destinationPoint(start.lat, start.lng, bearing, 18);
    // The bearing from the destination back to the start ≈ bearing + 180.
    const back = bearingBetween(d.lat, d.lng, start.lat, start.lng);
    expect(back).toBeCloseTo((bearing + 180) % 360, 1);
  });
  it('an 18m step barely moves the point (order ~1e-4 deg)', () => {
    const d = destinationPoint(40, -74, 90, 18);
    expect(Math.abs(d.lat - 40)).toBeLessThan(1e-3);
    expect(Math.abs(d.lng - -74)).toBeLessThan(1e-2);
    expect(d.lng).not.toBe(-74); // it DID move
  });
});
