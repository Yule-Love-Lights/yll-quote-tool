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
