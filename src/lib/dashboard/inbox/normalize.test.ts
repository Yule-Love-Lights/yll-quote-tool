import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizePhone, normalizeName, toDate, etDayKey, etHour } from './normalize';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  it('returns null for empty / blank', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });
  it('returns null for malformed addresses', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull(); // no TLD
  });
  it('returns null for non-string input', () => {
    expect(normalizeEmail(null as unknown as string)).toBeNull();
    expect(normalizeEmail(undefined as unknown as string)).toBeNull();
  });
});

describe('normalizePhone (US-default, YLL is Long Island)', () => {
  it('formats a US 10-digit to E.164', () => {
    expect(normalizePhone('(631) 555-1234')).toBe('+16315551234');
  });
  it('formats a US 11-digit leading 1 to E.164', () => {
    expect(normalizePhone('1-631-555-1234')).toBe('+16315551234');
  });
  it('passes through an already-E.164 number', () => {
    expect(normalizePhone('+16315551234')).toBe('+16315551234');
  });
  it('keeps a non-US +E.164 number as-is', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('returns null for too-short or junk input', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeName('  Cristina   Foss ')).toBe('Cristina Foss');
  });
  it('returns null for blank', () => {
    expect(normalizeName('   ')).toBeNull();
  });
});

describe('toDate — GHL returns two timestamp formats (spike finding)', () => {
  it('parses epoch milliseconds (the /conversations/search endpoint)', () => {
    expect(toDate(1782693272654).getTime()).toBe(1782693272654);
  });
  it('parses an ISO string (the /messages endpoint)', () => {
    expect(toDate('2026-06-29T00:34:32.731Z').toISOString()).toBe('2026-06-29T00:34:32.731Z');
  });
  it('parses an epoch supplied as a numeric string', () => {
    expect(toDate('1782693272654').getTime()).toBe(1782693272654);
  });
  it('passes a Date through unchanged', () => {
    const d = new Date('2026-06-28T12:00:00Z');
    expect(toDate(d)).toBe(d);
  });
});

describe('etDayKey / etHour — America/New_York', () => {
  it('maps a UTC instant to the ET calendar day in summer (EDT, UTC-4)', () => {
    // 2026-06-29T00:34Z is 2026-06-28 20:34 EDT → ET day is still the 28th.
    const d = new Date('2026-06-29T00:34:32.731Z');
    expect(etDayKey(d)).toBe('2026-06-28');
    expect(etHour(d)).toBe(20);
  });
  it('maps correctly in winter (EST, UTC-5)', () => {
    // 2026-01-15T02:00Z is 2026-01-14 21:00 EST.
    const d = new Date('2026-01-15T02:00:00Z');
    expect(etDayKey(d)).toBe('2026-01-14');
    expect(etHour(d)).toBe(21);
  });
});
