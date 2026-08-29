// Pins the GPS chip state machine and the single-freshness-rule contract.
// The delta-verify on PR #1090 caught the chip and the shutter using two
// different staleness thresholds (15s display vs 5s reuse), which let the
// chip vouch for a fix the shutter would refuse; these tests pin the
// extracted pure logic so the two cannot drift apart again.

import { describe, expect, it } from 'vitest';
import { chipStateFor, GPS_FRESH_MS, isFixFresh, type GpsPermission } from './cameraGps';

describe('isFixFresh — the ONE freshness rule (chip and shutter both use it)', () => {
  it('a fix younger than GPS_FRESH_MS is fresh; at or past the window it is not', () => {
    const now = 1_000_000;
    expect(isFixFresh(now - (GPS_FRESH_MS - 1), now)).toBe(true);
    expect(isFixFresh(now - GPS_FRESH_MS, now)).toBe(false);
    expect(isFixFresh(now - GPS_FRESH_MS * 3, now)).toBe(false);
  });

  it('no fix at all is never fresh', () => {
    expect(isFixFresh(null, 1_000_000)).toBe(false);
  });
});

describe('chipStateFor — every (status × freshness) combo maps to exactly one chip', () => {
  const matrix: Array<[GpsPermission, boolean, string]> = [
    ['starting', false, 'locating'],
    ['starting', true, 'locating'],
    ['ready', true, 'ready'],
    ['ready', false, 'locating'], // stale stream: never a green chip
    ['no_signal', false, 'locating'],
    ['no_signal', true, 'locating'],
    ['denied', false, 'blocked'],
    ['denied', true, 'blocked'],
    ['unsupported', false, 'unsupported'],
    ['unsupported', true, 'unsupported'],
  ];

  it.each(matrix)('%s with fixFresh=%s shows %s', (status, fresh, chip) => {
    expect(chipStateFor(status, fresh)).toBe(chip);
  });
});
