// Pure GPS chip logic for the capture screen, extracted so the state
// matrix and the freshness rule are testable without mounting the camera
// and geolocation stack.
//
// isFixTrustworthy is now the SINGLE source of truth for "trust this
// fix": the shutter reuses a warm watchPosition fix only when it says
// so, and the chip may only claim GPS ready under the exact same rule,
// fed the exact same (fix, previous, now) inputs. The delta-verify on PR
// #1090 caught the first cut using two thresholds (15s for the chip, 5s
// for the shutter), which let a green chip vouch for a fix the shutter
// would then refuse: the precise lying-chip class the chip exists to
// prevent. Never give the chip and the shutter separate copies of this
// logic again.
//
// 2026-08-31 field incident: cutting GPS_FRESH_MS from 25s to 5s (to
// stop a shot inheriting the PREVIOUS house's coordinates while the
// worker walks) meant almost every shutter press fell through to a cold
// getCurrentPosition, which then timed out near a roofline. A worker
// lost roughly one shot in five. Elapsed time alone is a poor stand-in
// for the thing that actually matters: has the worker MOVED since the
// fix arrived. A worker who has stood at one house for 15 seconds
// framing a shot is in no more danger of a wrong-house tag than one who
// has stood there for 4. watchPosition already streams a new fix
// whenever the OS has one, so comparing a fix against the ONE right
// before it answers "did they move" directly instead of guessing from
// the clock: if the two land within STATIONARY_RADIUS_M of each other,
// nothing moved, and the older fix can be trusted well past the fast
// path (GPS_STATIONARY_MAX_MS), provided its own accuracy is good enough
// to mean something at house scale (MAX_TRUSTED_ACCURACY_M). That last
// gate is what makes a precise-but-old fix beat a fresh-but-wild one: a
// 5m-accuracy fix from 15 seconds ago can earn the extension; a 50m fix
// never could, no matter how well it happens to match its predecessor,
// because 50m is already close to a whole house-to-house gap and says
// almost nothing about which house this is.

export const GPS_FRESH_MS = 5_000;

// How often the screen re-checks the last fix's age for the chip. Kept
// well under GPS_FRESH_MS so the display lags the truth by at most a
// second.
export const GPS_TICK_MS = 1_000;

// Two fixes within this many metres of each other count as the SAME
// spot, ordinary GPS jitter while the worker stands still, not a walk
// to the next house. Comfortably under the shortest real house-to-house
// gap (15m) so an actual move between adjacent houses is never misread
// as staying put.
export const STATIONARY_RADIUS_M = 8;

// A fix this imprecise or worse cannot vouch for which house the worker
// is at, no matter how well it matches the fix before it, so it never
// earns the extended trust window below. Kept under the 15m minimum
// house gap with real margin: a fix this good is trustworthy at house
// scale on its own.
export const MAX_TRUSTED_ACCURACY_M = 12;

// Once a fix is confirmed stationary (matches the fix before it, and is
// precise enough), trust it for this long before insisting on a fresh
// one. Bounded so a stalled watch, or a fix that is genuinely wrong,
// cannot vouch for a photo forever: comfortably past the ~11-18s it
// takes to walk the 15-25m to the next house, so a normal pause to frame
// a shot never trips it, without trusting a single reading indefinitely.
export const GPS_STATIONARY_MAX_MS = 30_000;

export type GpsPermission = 'starting' | 'ready' | 'denied' | 'no_signal' | 'unsupported';
export type GpsChip = 'ready' | 'locating' | 'blocked' | 'unsupported';

/** One GPS reading: where, how sure, and when it arrived (epoch ms). */
export interface GpsFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  at: number;
}

// Same radius Earth model isFixTrustworthy's distance check uses.
const EARTH_RADIUS_M = 6_371_000;

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when two fixes are close enough to be the SAME spot: ordinary
 * GPS jitter while the worker stands still, not a walk between houses. */
export function sameSpot(a: GpsFix, b: GpsFix): boolean {
  return distanceMeters(a.lat, a.lng, b.lat, b.lng) <= STATIONARY_RADIUS_M;
}

/** The one freshness rule, kept because it is exactly isFixTrustworthy's
 * fast path. `fixAt` is the epoch-ms of the last fix, or null when none
 * has arrived yet. */
export function isFixFresh(fixAt: number | null, now: number): boolean {
  return fixAt !== null && now - fixAt < GPS_FRESH_MS;
}

/**
 * THE freshness rule. Trust `fix` right now if either:
 *
 *  - FAST: it is younger than GPS_FRESH_MS. Unchanged from before,
 *    covers the very first shot at a house and a receiver that is
 *    updating quickly. No accuracy check here on purpose: a fix this
 *    recent needs no corroboration, and adding one now would only
 *    shrink coverage further, the opposite of this fix's goal.
 *  - STATIONARY: it is precise enough to mean something at house scale
 *    (MAX_TRUSTED_ACCURACY_M), it is still under GPS_STATIONARY_MAX_MS
 *    old, and it lands on the SAME SPOT as the fix immediately before it
 *    (sameSpot), direct evidence the worker has not moved since,
 *    instead of a guess from elapsed time alone.
 *
 * `previous` is the fix that arrived just before `fix` in the
 * watchPosition stream, or null when `fix` is the only one seen so far.
 * With nothing to compare against, it cannot take the STATIONARY path.
 */
export function isFixTrustworthy(fix: GpsFix, previous: GpsFix | null, now: number): boolean {
  const age = now - fix.at;
  if (age < GPS_FRESH_MS) return true;
  if (age >= GPS_STATIONARY_MAX_MS) return false;
  if (fix.accuracyM === null || fix.accuracyM > MAX_TRUSTED_ACCURACY_M) return false;
  return previous !== null && sameSpot(fix, previous);
}

/** Which chip the capture screen shows. Exactly one chip per combo. */
export function chipStateFor(status: GpsPermission, fixFresh: boolean): GpsChip {
  if (status === 'denied') return 'blocked';
  if (status === 'unsupported') return 'unsupported';
  return status === 'ready' && fixFresh ? 'ready' : 'locating';
}

// How a failed send is treated (Naldo, live incident 2026-08-31: a worker
// mid-run losing roughly one shot in five, and the app throwing each lost
// photo away). A photo that has been TAKEN is never discarded by the app.
export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'no_gps'; denied: boolean }
  | { kind: 'too_large' }
  | { kind: 'refused'; status: number; message?: string }
  | { kind: 'network' };

export type SendDecision =
  /** Hold the photo and try again; the worker sees a waiting state. */
  | { action: 'retry'; reason: string }
  /** Stop trying, keep the photo, let the worker tap to try again. */
  | { action: 'hold'; reason: string }
  | { action: 'done' };

export const MAX_SEND_ATTEMPTS = 6;

/** PURE. Retry anything that a later attempt could plausibly fix, and stop
 * only where retrying is pointless: a photo too big to compress, or a 4xx,
 * which is the server saying this request is wrong and will stay wrong.
 * Even then the photo is HELD, never dropped. */
export function decideSend(outcome: SendOutcome, attempt: number): SendDecision {
  if (outcome.kind === 'ok') return { action: 'done' };
  if (outcome.kind === 'too_large') {
    return { action: 'hold', reason: 'This photo is too large even after compression.' };
  }
  if (outcome.kind === 'refused' && outcome.status >= 400 && outcome.status < 500) {
    return { action: 'hold', reason: outcome.message ?? 'The server refused this photo.' };
  }
  const reason =
    outcome.kind === 'no_gps'
      ? outcome.denied
        ? 'Waiting for location access.'
        : 'Waiting for a GPS fix.'
      : outcome.kind === 'network'
        ? 'No connection.'
        : (outcome.message ?? 'Upload did not go through.');
  if (attempt >= MAX_SEND_ATTEMPTS) return { action: 'hold', reason: `${reason} Tap to try again.` };
  return { action: 'retry', reason };
}

/** Backoff between attempts, capped so a dead zone cannot flatten the radio. */
export function retryDelayMs(attempt: number): number {
  return Math.min(2000 * attempt, 15000);
}
