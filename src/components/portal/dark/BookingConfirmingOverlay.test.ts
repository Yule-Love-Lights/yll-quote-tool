import { describe, it, expect } from 'vitest';
import { shouldConfirmBooking } from './BookingConfirmingOverlay';

describe('shouldConfirmBooking (#166 deposit race)', () => {
  it('shows the confirming overlay right after paying, before the webhook lands', () => {
    expect(shouldConfirmBooking('1', false)).toBe(true);
  });

  it('hides once the webhook has marked the deposit paid', () => {
    expect(shouldConfirmBooking('1', true)).toBe(false);
  });

  it('hides on a normal approved-not-paid visit (no confirming marker)', () => {
    expect(shouldConfirmBooking(undefined, false)).toBe(false);
    expect(shouldConfirmBooking('0', false)).toBe(false);
  });
});
