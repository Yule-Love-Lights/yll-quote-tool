// Pure-logic tests for the partial-capture helpers (the house convention is
// pure-logic tests — no jsdom). Covers the two load-bearing decisions the hook
// leans on: (1) a lone name isn't a lead, and (2) the de-dup key that stops one
// page navigation (visibilitychange + pagehide) from double-posting a partial.

import { describe, it, expect } from 'vitest';
import { buildPartialPayload, partialCaptureKey } from './usePartialCapture';

const CFG = { source: 'referral', formVariant: 'referral:ABC', service: undefined };

describe('buildPartialPayload', () => {
  it('returns null when there is no usable contact handle (lone name)', () => {
    expect(buildPartialPayload({ name: 'Jane Only' }, CFG, null)).toBeNull();
    expect(buildPartialPayload({ name: 'Jane', phone: '123' }, CFG, null)).toBeNull(); // <7 digits
    expect(buildPartialPayload({ email: 'not-an-email' }, CFG, null)).toBeNull();
  });

  it('builds a payload for an email-only fill (no phone key)', () => {
    const p = buildPartialPayload({ name: 'Jane', email: 'jane@example.com' }, CFG, null);
    expect(p).toMatchObject({ name: 'Jane', email: 'jane@example.com', source: 'referral', formVariant: 'referral:ABC' });
    expect(p!.phone).toBeUndefined();
  });

  it('builds a payload for a phone-only fill (no email key)', () => {
    const p = buildPartialPayload({ phone: '(516) 555-0137' }, CFG, null);
    expect(p!.phone).toBe('(516) 555-0137');
    expect(p!.email).toBeUndefined();
    expect(p!.name).toBeUndefined();
  });

  it('threads captureId and landingUrl through', () => {
    const p = buildPartialPayload({ email: 'jane@example.com' }, CFG, 'row-42', 'https://x/y');
    expect(p!.captureId).toBe('row-42');
    expect(p!.landingUrl).toBe('https://x/y');
  });
});

describe('partialCaptureKey (de-dup)', () => {
  const base = { name: 'Jane', email: 'jane@example.com', phone: '5165550137' };

  it('is identical for identical contact data → a repeat is skipped', () => {
    const a = buildPartialPayload(base, CFG, null)!;
    const b = buildPartialPayload(base, CFG, null)!;
    expect(partialCaptureKey(a)).toBe(partialCaptureKey(b));
  });

  it('changes when any contact field changes → new data still posts', () => {
    const a = buildPartialPayload(base, CFG, null)!;
    const b = buildPartialPayload({ ...base, phone: '5165559999' }, CFG, null)!;
    expect(partialCaptureKey(a)).not.toBe(partialCaptureKey(b));
  });

  it('does NOT change when only captureId changes — learning a row id never forces a re-send', () => {
    const a = buildPartialPayload(base, CFG, null)!;
    const b = buildPartialPayload(base, CFG, 'row-1')!;
    expect(partialCaptureKey(a)).toBe(partialCaptureKey(b));
  });
});
