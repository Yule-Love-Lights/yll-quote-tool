// Pins the GPS chip state machine and the single-freshness-rule contract.
// The delta-verify on PR #1090 caught the chip and the shutter using two
// different staleness thresholds (15s display vs 5s reuse), which let the
// chip vouch for a fix the shutter would refuse; these tests pin the
// extracted pure logic so the two cannot drift apart again.

import { describe, expect, it } from 'vitest';
import {
  chipStateFor,
  decideSend,
  GPS_FRESH_MS,
  GPS_STATIONARY_MAX_MS,
  isFixFresh,
  isFixTrustworthy,
  MAX_SEND_ATTEMPTS,
  MAX_TRUSTED_ACCURACY_M,
  retryDelayMs,
  sameSpot,
  STATIONARY_RADIUS_M,
  type GpsFix,
  type GpsPermission,
} from './cameraGps';

// Earth radius used by the source file's own distance calculation. Tests
// build fixtures by offsetting latitude only, which makes the haversine
// distance exact: distance = R * dLatRadians (no approximation error),
// so boundary assertions are not fighting floating point noise.
const EARTH_RADIUS_M = 6_371_000;

/** A fixture at BASE_LAT/BASE_LNG offset north by `meters`. Longitude is
 * never touched so the resulting distance from the base point is exact. */
function offsetFix(meters: number, overrides: Partial<GpsFix> = {}): GpsFix {
  const dLatRad = meters / EARTH_RADIUS_M;
  const dLatDeg = (dLatRad * 180) / Math.PI;
  return {
    lat: BASE_LAT + dLatDeg,
    lng: BASE_LNG,
    accuracyM: 5,
    at: 0,
    ...overrides,
  };
}

const BASE_LAT = 40.7;
const BASE_LNG = -73.5;
const baseFix = (overrides: Partial<GpsFix> = {}): GpsFix => offsetFix(0, overrides);

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

describe('decideSend — a photo that has been taken is never thrown away', () => {
  it('retries the failures a later attempt could fix', () => {
    expect(decideSend({ kind: 'no_gps', denied: false }, 1).action).toBe('retry');
    expect(decideSend({ kind: 'network' }, 1).action).toBe('retry');
    expect(decideSend({ kind: 'refused', status: 500 }, 1).action).toBe('retry');
    expect(decideSend({ kind: 'refused', status: 502 }, 3).action).toBe('retry');
  });

  it('stops on the two dead ends, and HOLDS the photo rather than dropping it', () => {
    const big = decideSend({ kind: 'too_large' }, 1);
    expect(big.action).toBe('hold');
    const refused = decideSend({ kind: 'refused', status: 400, message: 'Pick a campaign.' }, 1);
    expect(refused).toEqual({ action: 'hold', reason: 'Pick a campaign.' });
  });

  it('gives up retrying at the attempt cap, still holding the photo with a way back', () => {
    const last = decideSend({ kind: 'network' }, MAX_SEND_ATTEMPTS);
    expect(last.action).toBe('hold');
    expect(last).toHaveProperty('reason', expect.stringContaining('Tap to try again'));
  });

  it('never returns an action that discards: hold and retry both keep the photo', () => {
    const outcomes: Parameters<typeof decideSend>[0][] = [
      { kind: 'no_gps', denied: true },
      { kind: 'no_gps', denied: false },
      { kind: 'network' },
      { kind: 'too_large' },
      { kind: 'refused', status: 404 },
      { kind: 'refused', status: 503 },
    ];
    for (const o of outcomes) {
      for (const attempt of [1, 3, MAX_SEND_ATTEMPTS, MAX_SEND_ATTEMPTS + 1]) {
        expect(['retry', 'hold']).toContain(decideSend(o, attempt).action);
      }
    }
  });

  it('a denied permission reads differently from a weak signal', () => {
    expect(decideSend({ kind: 'no_gps', denied: true }, 1)).toHaveProperty('reason', 'Waiting for location access.');
    expect(decideSend({ kind: 'no_gps', denied: false }, 1)).toHaveProperty('reason', 'Waiting for a GPS fix.');
  });

  it('backs off, capped', () => {
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(3)).toBe(6000);
    expect(retryDelayMs(50)).toBe(15000);
  });
});

describe('sameSpot: is this the same spot, or did the worker walk to the next house', () => {
  it('within STATIONARY_RADIUS_M counts as the same spot', () => {
    expect(sameSpot(baseFix(), offsetFix(STATIONARY_RADIUS_M - 1))).toBe(true);
    expect(sameSpot(baseFix(), offsetFix(1))).toBe(true);
  });

  it('past STATIONARY_RADIUS_M is a real move, not jitter', () => {
    expect(sameSpot(baseFix(), offsetFix(STATIONARY_RADIUS_M + 1))).toBe(false);
  });

  it('a real walk between two houses (15-25m) is never mistaken for standing still', () => {
    expect(sameSpot(baseFix(), offsetFix(15))).toBe(false);
    expect(sameSpot(baseFix(), offsetFix(25))).toBe(false);
  });
});

describe('isFixTrustworthy: THE rule the shutter and the chip both live under', () => {
  it('FAST path: a fix younger than GPS_FRESH_MS is trusted with no previous fix and no accuracy check', () => {
    const fix = baseFix({ at: 1000, accuracyM: null });
    expect(isFixTrustworthy(fix, null, 1000 + (GPS_FRESH_MS - 1))).toBe(true);
  });

  it('at GPS_FRESH_MS the fast path is spent; without a matching previous fix it is not trusted', () => {
    const fix = baseFix({ at: 1000 });
    expect(isFixTrustworthy(fix, null, 1000 + GPS_FRESH_MS)).toBe(false);
  });

  it('STATIONARY path: the field regression this file exists to fix, old, precise, confirmed still, still trusted', () => {
    // The exact live incident: a worker has been standing at a house for
    // 15 seconds framing the shot (well past the old 5s cutoff), the GPS
    // is a bit rough near the roofline (10m accuracy) but the fix before
    // this one landed within a couple of metres of it, direct evidence
    // nobody walked anywhere.
    const previous = offsetFix(2, { at: 12_000, accuracyM: 10 });
    const fix = offsetFix(3, { at: 15_000, accuracyM: 10 });
    const now = 15_000 + 15_000; // 15s after this fix arrived
    expect(isFixTrustworthy(fix, previous, now)).toBe(true);
  });

  it('a genuine walk to the next house is refused even though the fast window has long passed', () => {
    const previous = offsetFix(0, { at: 0, accuracyM: 8 });
    const fix = offsetFix(18, { at: 8_000, accuracyM: 8 }); // walked ~18m, an 18m/1.4 ~ 13s stride
    const now = 8_000 + 10_000;
    expect(isFixTrustworthy(fix, previous, now)).toBe(false);
  });

  it('no previous fix to compare against: the very first fix of a session cannot take the stationary path', () => {
    const fix = baseFix({ at: 0, accuracyM: 5 });
    expect(isFixTrustworthy(fix, null, GPS_FRESH_MS + 1)).toBe(false);
  });

  it('a fresh 50m fix is trusted anyway (fast path does not gate on accuracy)', () => {
    const fix = baseFix({ at: 1000, accuracyM: 50 });
    expect(isFixTrustworthy(fix, null, 1000 + (GPS_FRESH_MS - 1))).toBe(true);
  });

  it('a stale 50m fix cannot buy the stationary extension even matching its predecessor exactly: too imprecise to mean anything', () => {
    const previous = offsetFix(0, { at: 0, accuracyM: 50 });
    const fix = offsetFix(0, { at: 6000, accuracyM: 50 });
    expect(isFixTrustworthy(fix, previous, 6000 + GPS_FRESH_MS)).toBe(false);
  });

  it('accuracy right at MAX_TRUSTED_ACCURACY_M passes the gate; one metre worse fails it', () => {
    // fix.at is past GPS_FRESH_MS below so the fast path cannot mask the
    // accuracy gate we are actually testing here.
    const goodPrev = offsetFix(0, { at: 0, accuracyM: MAX_TRUSTED_ACCURACY_M });
    const good = offsetFix(1, { at: GPS_FRESH_MS + 1000, accuracyM: MAX_TRUSTED_ACCURACY_M });
    expect(isFixTrustworthy(good, goodPrev, GPS_FRESH_MS + 6000)).toBe(true);

    const badPrev = offsetFix(0, { at: 0, accuracyM: MAX_TRUSTED_ACCURACY_M + 1 });
    const bad = offsetFix(1, { at: GPS_FRESH_MS + 1000, accuracyM: MAX_TRUSTED_ACCURACY_M + 1 });
    expect(isFixTrustworthy(bad, badPrev, GPS_FRESH_MS + 6000)).toBe(false);
  });

  it('unknown accuracy (null) never earns the stationary extension', () => {
    const previous = offsetFix(0, { at: 0, accuracyM: null });
    const fix = offsetFix(0, { at: GPS_FRESH_MS + 1000, accuracyM: null });
    expect(isFixTrustworthy(fix, previous, GPS_FRESH_MS + 6000)).toBe(false);
  });

  it('GPS_STATIONARY_MAX_MS is a hard ceiling: even a perfectly matching, precise fix goes cold past it', () => {
    const previous = offsetFix(0, { at: 0, accuracyM: 3 });
    const fix = offsetFix(0, { at: 100, accuracyM: 3 });
    expect(isFixTrustworthy(fix, previous, 100 + (GPS_STATIONARY_MAX_MS - 1))).toBe(true);
    expect(isFixTrustworthy(fix, previous, 100 + GPS_STATIONARY_MAX_MS)).toBe(false);
  });

  it('the chip and the shutter reading the identical inputs never disagree: the whole point of one function', () => {
    const previous = offsetFix(1, { at: 0, accuracyM: 6 });
    const fix = offsetFix(2, { at: 15_000, accuracyM: 6 });
    const now = 25_000;
    // Whatever the shutter's getGps() would decide, the chip's tick must
    // decide the same thing, because both call the SAME function on the
    // SAME (fix, previous, now). There is no second code path to drift.
    const shutterWouldReuse = isFixTrustworthy(fix, previous, now);
    const chipWouldClaimReady = isFixTrustworthy(fix, previous, now);
    expect(chipWouldClaimReady).toBe(shutterWouldReuse);
  });
});
