import { describe, expect, it } from 'vitest';

import { etInputToIso, isoToEtInput } from './etClock';

// Payroll times typed as ET must round-trip exactly, including on both DST
// transition days (this repo's row-335 class: an hour of pay rides on it).

describe('etInputToIso', () => {
  it('summer (EDT, UTC-4)', () => {
    expect(etInputToIso('2026-08-10T07:00')).toBe('2026-08-10T11:00:00.000Z');
  });

  it('winter (EST, UTC-5)', () => {
    expect(etInputToIso('2026-01-15T07:00')).toBe('2026-01-15T12:00:00.000Z');
  });

  it('spring-forward day, after the jump (2026-03-08 is the transition)', () => {
    expect(etInputToIso('2026-03-08T07:00')).toBe('2026-03-08T11:00:00.000Z');
  });

  it('fall-back day, after the repeat hour (2026-11-01 is the transition)', () => {
    expect(etInputToIso('2026-11-01T07:00')).toBe('2026-11-01T12:00:00.000Z');
  });

  it('rejects garbage', () => {
    expect(etInputToIso('not-a-time')).toBeNull();
    expect(etInputToIso('')).toBeNull();
  });
});

describe('round-trip', () => {
  it.each(['2026-08-10T07:00', '2026-01-15T16:45', '2026-03-08T07:00', '2026-11-01T07:00'])(
    '%s survives iso and back',
    (local) => {
      const iso = etInputToIso(local);
      expect(iso).not.toBeNull();
      expect(isoToEtInput(iso as string)).toBe(local);
    },
  );
});
