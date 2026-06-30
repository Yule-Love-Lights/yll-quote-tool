// Pure normalization helpers for inbox ingestion. No I/O, no Date.now — every
// function is deterministic given its inputs (the timestamp helpers take the
// instant explicitly), so they're trivially unit-testable.
//
// Two facts from the GHL spike (2026-06-28) shape this file:
//   • timestamps arrive as epoch-ms (search) AND ISO strings (messages) → toDate
//     accepts both.
//   • "due today" / escalation are evaluated in America/New_York → etDayKey/etHour
//     give the ET calendar day + hour for any instant (DST-correct via Intl).

const ET_TIME_ZONE = 'America/New_York';

/** Lowercase + trim an email; null unless it's a plausible addr@domain.tld.
 *  Excludes the PostgREST filter delimiters , ( ) { } as well as @/whitespace —
 *  emails never legitimately contain those, and it keeps a normalized value safe
 *  to interpolate into a `.or()` array filter (see identity lookups in store.ts). */
export function normalizeEmail(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (!/^[^\s@,(){}]+@[^\s@,(){}]+\.[^\s@,(){}]+$/.test(v)) return null;
  return v;
}

/**
 * Best-effort E.164 normalization, US-defaulted (YLL is Long Island). Returns
 * null when we can't confidently form an E.164 number — better an unmatched
 * contact than a wrong merge.
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Collapse internal whitespace + trim; null when blank. Display-only. */
export function normalizeName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/\s+/g, ' ').trim();
  return v || null;
}

/** Accept epoch-ms (number or all-digit string), an ISO string, or a Date. */
export function toDate(value: number | string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^\d+$/.test(v)) return new Date(Number(v)); // epoch-ms as a string
    return new Date(v); // ISO 8601
  }
  throw new TypeError(`toDate: unsupported value ${String(value)}`);
}

/** Extract ET calendar fields for an instant (DST-correct). */
function etParts(d: Date): { year: string; month: string; day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')) % 24, // some runtimes emit '24' for midnight
  };
}

/** ET calendar day as YYYY-MM-DD (string-sortable). */
export function etDayKey(d: Date): string {
  const { year, month, day } = etParts(d);
  return `${year}-${month}-${day}`;
}

/** ET hour of day, 0–23. */
export function etHour(d: Date): number {
  return etParts(d).hour;
}
