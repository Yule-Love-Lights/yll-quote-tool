// Pins the GPS chip state machine and the single-freshness-rule contract.
// The delta-verify on PR #1090 caught the chip and the shutter using two
// different staleness thresholds (15s display vs 5s reuse), which let the
// chip vouch for a fix the shutter would refuse; these tests pin the
// extracted pure logic so the two cannot drift apart again.
//
// 2026-08-31 review: an earlier draft of this file added a second rule
// (isFixTrustworthy) that extended trust for an aging fix whenever it
// matched the fix immediately before it. A review proved that unsound
// with a stalled-stream counter-example (see cameraGps.ts's header
// comment for the full reasoning) before it ever shipped or was wired
// into the camera. That rule and its tests are gone; the two tests below
// (in the isFixFresh block) pin the counter-example and the safety math
// directly against the ONE rule that remains.

import { describe, expect, it } from 'vitest';
import {
  chipStateFor,
  COLD_FIX_OPTIONS,
  decideSend,
  GPS_FRESH_MS,
  isFixFresh,
  MAX_SEND_ATTEMPTS,
  retryDelayMs,
  type GpsPermission,
} from './cameraGps';

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

  it('a stalled stream: a fix that once matched its predecessor is still refused once it is stale (2026-08-31 review)', () => {
    // The exact counter-example a review raised against a since-removed
    // rule. Fixes arrive at t=0 and t=1s, both from the same spot, then
    // the stream stalls, which is precisely what happens near a
    // roofline. The worker walks on; by t=16s the t=1s fix is 15s stale.
    // Nothing about the t=0/t=1s pair can speak to what happened in the
    // 15 unobserved seconds since, so isFixFresh must refuse it, and
    // does, because it never looks at any fix but the current one.
    expect(isFixFresh(1_000, 16_000)).toBe(false);
  });

  it('GPS_FRESH_MS worst-case drift stays under half the shortest real house-to-house gap', () => {
    // Turns the header comment's safety claim into an assertion instead
    // of a hope: at WALKING_SPEED_MPS, GPS_FRESH_MS bounds how far the
    // worker could have walked, unobserved, since the fix arrived. That
    // worst case must stay under half of MIN_HOUSE_GAP_M, the shortest
    // real gap this file was written for, so even the worst case (a
    // straight-line walk toward the very next house for the whole
    // window) leaves the true position closer to the named house than
    // to its neighbor. If GPS_FRESH_MS is ever widened without
    // rechecking this, this is the test that catches it.
    const WALKING_SPEED_MPS = 1.4; // brief: "a walking worker covers about 1.4 metres per second"
    const MIN_HOUSE_GAP_M = 15; // brief: "houses are roughly 15 to 25 metres apart"
    const worstCaseDriftM = WALKING_SPEED_MPS * (GPS_FRESH_MS / 1000);
    expect(worstCaseDriftM).toBeLessThan(MIN_HOUSE_GAP_M / 2);
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

describe('COLD_FIX_OPTIONS — the fallback never accepts a fix the fast path would refuse', () => {
  it('allows a cached fix exactly as old as the freshness window, and no older', () => {
    // Tied to the same constant on purpose: if someone widens the trust
    // window without thinking, this stays coherent; if someone loosens
    // maximumAge on its own, this fails.
    expect(COLD_FIX_OPTIONS.maximumAge).toBe(GPS_FRESH_MS);
    expect(isFixFresh(1_000_000 - (COLD_FIX_OPTIONS.maximumAge ?? 0), 1_000_000)).toBe(false);
    expect(isFixFresh(1_000_000 - (COLD_FIX_OPTIONS.maximumAge ?? 0) + 1, 1_000_000)).toBe(true);
  });

  it('still asks for a high accuracy fix and still gives up rather than hanging', () => {
    expect(COLD_FIX_OPTIONS.enableHighAccuracy).toBe(true);
    expect(COLD_FIX_OPTIONS.timeout).toBeGreaterThan(0);
  });
});
