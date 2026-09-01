// Pure GPS chip logic for the capture screen, extracted so the state
// matrix and the freshness rule are testable without mounting the camera
// and geolocation stack.
//
// isFixFresh is the SINGLE source of truth for "fresh": the shutter
// reuses a warm watchPosition fix only when it says so, and the chip may
// only claim GPS ready under the exact same rule. The delta-verify on PR
// #1090 caught an earlier cut using two thresholds (15s for the chip, 5s
// for the shutter), which let a green chip vouch for a fix the shutter
// would then refuse: the precise lying-chip class the chip exists to
// prevent. Never give the chip and the shutter separate copies of this
// logic again.
//
// 2026-08-31 field incident: cutting GPS_FRESH_MS from 25s to 5s (to
// stop a shot inheriting the PREVIOUS house's coordinates while the
// worker walks) meant almost every shutter press fell through to a cold
// getCurrentPosition, which then timed out near a roofline. A worker
// lost roughly one shot in five.
//
// A same-day fix tried to buy back some of that window by comparing
// consecutive watchPosition fixes: if a fix landed on the same spot as
// the one right before it, trust it well past the fast path, on the
// theory that two agreeing fixes are evidence the worker has not moved.
// A review proved that unsound with a direct counter-example: two fixes
// one second apart at house A, then the stream stalls, which is exactly
// what happens near a roofline, the same condition this file was
// written for. The worker walks 20m to house B over 15 seconds and
// shoots using the second fix, now 15s stale. It still matches the
// fix before it, so the old rule trusted it, and tagged the photo at
// house A. The flaw: two fixes agreeing proves the worker did not move
// DURING THE INTERVAL BETWEEN THEM. It says nothing about the interval
// SINCE the newer one, which is the interval that actually matters, and
// the one a stalled stream makes long. Worse, the extension only ever
// mattered in exactly the state where its evidence was worthless: a
// live, updating stream means the newest fix is already fresh and the
// fast path already covers it, so the only case where a stalled-stream
// comparison could fire is the one case it cannot speak to at all. No
// amount of comparing fixes taken before a gap can bound what happened
// during the gap. Only elapsed time, checked against a worst-case
// walking speed, can do that honestly. That is what isFixFresh already
// does, so it was left as the whole rule rather than patched further.
//
// The worst case this leaves standing: GPS_FRESH_MS is 5s, and at the
// walking pace this file assumes (1.4 m/s, see the shoot handler's own
// comment), 5s of unobserved walking is at most 7m of drift. Houses on
// a real block sit at least 15m apart, so 7m is comfortably under half
// that gap: even in the worst case, a straight-line walk toward the
// very next house for the full 5 seconds, the true position stays
// closer to the house the fix names than to its neighbor. That margin
// (0.5m at 1.4 m/s, about 350ms) is real but too small to be worth
// spending: it would not meaningfully cut how often the roofline cold
// lookup fires, and 5s is easy to reason about and already tested.
// GPS_FRESH_MS is left unchanged.
//
// What actually absorbs the cost of the roofline cold lookup failing is
// a separate, already-shipped fix: a shot with no trustworthy GPS is
// held and retried automatically (decideSend, below), never discarded.
// So refusing a stale fix now costs the worker a short wait, not a lost
// photo, which is why staying conservative here is the right trade
// rather than reaching for a clever extension again.

export const GPS_FRESH_MS = 5_000;

// How often the screen re-checks the last fix's age for the chip. Kept
// well under GPS_FRESH_MS so the display lags the truth by at most a
// second.
export const GPS_TICK_MS = 1_000;

// Options for the one-shot fix the shutter falls back to when the watch
// has not produced anything fresh. maximumAge is deliberately tied to
// GPS_FRESH_MS rather than left at 0: asking the OS for a brand new fix
// refuses a cached one that is a single second old, which is STRICTER
// than our own money rule, since the fast path already trusts anything
// under GPS_FRESH_MS. Near a roofline that pointless strictness is what
// times out and costs the worker a wait (Naldo, field incident
// 2026-08-31). A cached fix inside the same window is exactly as
// trustworthy as a streamed one of the same age.
export const COLD_FIX_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: GPS_FRESH_MS,
};

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

// How a failed send is treated (Naldo, live incident 2026-08-31: a worker
// mid-run losing roughly one shot in five, and the app throwing each lost
// photo away). A photo that has been TAKEN is never discarded by the app.
export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'no_gps'; denied: boolean }
  /** A fix arrived, but too long after the shutter to describe the
   * house the photo was taken at. */
  | { kind: 'stale_location' }
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
  if (outcome.kind === 'stale_location') {
    // Retrying cannot travel back in time, and tagging the photo with a
    // later position would put it at the wrong house. The worker decides.
    return {
      action: 'hold',
      reason: 'No location was recorded near where this was taken. Send it and the office will place it by the photo, or discard it.',
    };
  }
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

// A photo belongs to the house it was SHOT at, not to wherever the worker
// stands when the send finally goes through. Once a photo can be held and
// retried (and restored a day later), reading the GPS at send time tags it
// with the wrong house and stamps the wrong time: the exact money error the
// freshness rule above exists to prevent, arriving through the back door
// (staff lens HIGH at the S81 close, on my own retry change).
//
// So the position and the time are decided ONCE, as close to the shutter as
// the phone allows, and reused by every attempt. When no fix exists at the
// shutter the app keeps trying, but only inside this grace window: a fix
// acquired later than this describes a different place, and a photo that
// never got one inside it is handed to the worker rather than tagged with
// a guess.
export const GPS_STAMP_GRACE_MS = 45_000;

/** PURE. May a fix acquired at `fixAt` stand as the location of a photo
 * shot at `shutterAt`? */
export function stampIsUsable(shutterAt: number, fixAt: number): boolean {
  const delay = fixAt - shutterAt;
  return delay >= 0 && delay < GPS_STAMP_GRACE_MS;
}
