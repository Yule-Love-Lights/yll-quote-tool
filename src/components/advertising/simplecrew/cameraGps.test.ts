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
