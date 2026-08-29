// Pure GPS chip logic for the capture screen, extracted so the state
// matrix and the freshness rule are testable without mounting the camera
// and geolocation stack.
//
// GPS_FRESH_MS is the SINGLE source of truth for "fresh": the shutter
// reuses a warm watchPosition fix under it, and the chip may only claim
// GPS ready under the exact same rule. The delta-verify on PR #1090
// caught the first cut using two thresholds (15s for the chip, 5s for
// the shutter), which let a green chip vouch for a fix the shutter would
// then refuse — the precise lying-chip class the chip exists to prevent.

export const GPS_FRESH_MS = 5_000;

// How often the screen re-checks the last fix's age for the chip. Kept
// well under GPS_FRESH_MS so the display lags the truth by at most a
// second.
export const GPS_TICK_MS = 1_000;

export type GpsPermission = 'starting' | 'ready' | 'denied' | 'no_signal' | 'unsupported';
export type GpsChip = 'ready' | 'locating' | 'blocked' | 'unsupported';

/** The one freshness rule. `fixAt` is the epoch-ms of the last fix, or
 * null when none has arrived yet. */
export function isFixFresh(fixAt: number | null, now: number): boolean {
  return fixAt !== null && now - fixAt < GPS_FRESH_MS;
}

/** Which chip the capture screen shows. Exactly one chip per combo. */
export function chipStateFor(status: GpsPermission, fixFresh: boolean): GpsChip {
  if (status === 'denied') return 'blocked';
  if (status === 'unsupported') return 'unsupported';
  return status === 'ready' && fixFresh ? 'ready' : 'locating';
}
