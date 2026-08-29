// Anchors a rep's promised time-of-day to an absolute instant using the
// CALL's wall-clock date (call_transcripts.called_at), never extraction
// time (calls_merge_plan_2026-08.md slice S6). Extraction runs well after
// the call, so resolving against "now" would put a "3-ish" promise at the
// wrong hour and could roll it to the wrong calendar day near midnight.
//
// Ported from the yll-call-copilot repo's src/lib/commitments/time.ts
// (master fb1bf326) — same DST-correct Intl technique this repo already
// uses elsewhere (src/lib/dashboard/inbox/normalize.ts's ET_TIME_ZONE,
// src/lib/opsMidnightClose.ts, src/lib/jobs/completingToday.ts): read the
// zone's wall-clock fields directly via Intl.DateTimeFormat, no manual
// UTC-offset arithmetic. Extended here to also WRITE a zoned wall-clock
// time back to a UTC instant — no shared COMPANY_TIMEZONE export exists in
// this repo (every consumer above inlines the zone string), so this file
// does the same rather than inventing a new shared export for one caller.

import { MAX_PROMISED_DAY_OFFSET } from './types';

const COMMITMENTS_TIME_ZONE = 'America/New_York';

function localDateParts(timeZone: string, at: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
  const parts = formatter.formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// The zone's UTC offset in minutes (e.g. -300 for EST) AT the given instant
// -- read directly via Intl rather than computed from a fixed rule, so DST
// transitions resolve correctly with zero manual date math.
function utcOffsetMinutes(timeZone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' });
  const offsetPart = formatter.formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = offsetPart.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// Converts a local wall-clock date/time in `timeZone` to the UTC instant it
// represents. The offset is read from the GUESSED instant itself (correct
// except in the vanishingly rare case of a promise landing exactly inside a
// DST spring-forward gap) -- acceptable for a reminder feature, not a
// billing one.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute);
  const offset = utcOffsetMinutes(timeZone, new Date(guessMs));
  return new Date(guessMs - offset * 60000);
}

// promisedTimeLocal: "HH:MM" 24-hour local time in COMMITMENTS_TIME_ZONE, as
// extracted by src/lib/commitments/extract.ts. Null (no specific time
// mentioned) short-circuits to null -- most commitments have no time.
// promisedDayOffset: days after the call's local calendar date (0 = later
// today, 1 = tomorrow, ...); null is treated as 0 (same day), the common
// case when the rep gave a time but not an explicit day.
export function resolvePromisedAt(
  calledAt: string | Date | null,
  promisedTimeLocal: string | null,
  promisedDayOffset: number | null,
): string | null {
  if (!promisedTimeLocal || !calledAt) return null;
  if (
    promisedDayOffset !== null
    && (!Number.isInteger(promisedDayOffset) || promisedDayOffset < 0 || promisedDayOffset > MAX_PROMISED_DAY_OFFSET)
  ) return null;

  const match = promisedTimeLocal.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const calledAtDate = typeof calledAt === 'string' ? new Date(calledAt) : calledAt;
  if (Number.isNaN(calledAtDate.getTime())) return null;

  const { year, month, day } = localDateParts(COMMITMENTS_TIME_ZONE, calledAtDate);
  // Calendar-day arithmetic on a neutral UTC-field container -- never goes
  // through a zoned Date, so it's immune to DST; this is pure Y/M/D
  // bookkeeping, not a zone conversion.
  const offsetDate = new Date(Date.UTC(year, month - 1, day + (promisedDayOffset ?? 0)));

  return zonedTimeToUtc(
    offsetDate.getUTCFullYear(),
    offsetDate.getUTCMonth() + 1,
    offsetDate.getUTCDate(),
    hour,
    minute,
    COMMITMENTS_TIME_ZONE,
  ).toISOString();
}
