import { describe, it, expect } from 'vitest';
import { chargeSlotLabel, chargeSlotTitle } from './page';

// The Status column on /admin/installments is the only place a staffer learns
// that a payment's charge slot is not empty. These pin the WORDING, because the
// wording is the whole safety property here: the ambiguous-timeout marker lives
// in the same column as a real Valor transaction id, and presenting it as one
// sends a staffer to search Valor for a reference that does not exist — which
// reads as "the charge never happened" and invites collecting the money twice.
// (Adversarial delta-verify on the PR #1051 fix round.)

const MARKER = 'ambiguous-timeout:2026-09-05T13:00:00.000Z';

describe('chargeSlotLabel', () => {
  it('says nothing for an ordinary empty slot, so a plain payment renders normally', () => {
    expect(chargeSlotLabel(null)).toBeNull();
  });

  it('flags a real transaction sitting on an unpaid payment', () => {
    expect(chargeSlotLabel('TXN-9911')).toBe('Charged — not recorded');
  });

  it('calls a timed-out charge unknown, not charged', () => {
    expect(chargeSlotLabel(MARKER)).toBe('Charge outcome unknown');
  });

  it('flags a claim that never completed', () => {
    expect(chargeSlotLabel('pending:2026-09-05T13:00:00.000Z')).toBe('Charge claimed — check Valor');
  });
});

describe('chargeSlotTitle', () => {
  it('never presents the timeout marker as a Valor reference', () => {
    const title = chargeSlotTitle(MARKER);
    expect(title).not.toContain('Valor reference');
    expect(title).not.toContain('ambiguous-timeout:');
    expect(title).toContain('2026-09-05T13:00:00.000Z');
    expect(title).toContain('do not assume it failed');
  });

  it('does name a real transaction id, which a staffer CAN look up', () => {
    expect(chargeSlotTitle('TXN-9911')).toContain('Valor reference TXN-9911');
  });

  it('explains an incomplete claim without claiming money moved', () => {
    const title = chargeSlotTitle('pending:2026-09-05T13:00:00.000Z');
    expect(title).toContain('never completed');
    expect(title).toContain('will not retry');
  });

  it('is empty for an untouched payment', () => {
    expect(chargeSlotTitle(null)).toBe('');
  });
});
