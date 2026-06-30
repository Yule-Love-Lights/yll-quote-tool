import { describe, it, expect } from 'vitest';
import { canTransition, asInvoiceStatus, INVOICE_STATUSES } from './invoiceStatus';

describe('invoiceStatus.canTransition', () => {
  it('allows the forward lifecycle', () => {
    expect(canTransition('draft', 'awaiting_payment')).toBe(true);
    expect(canTransition('draft', 'paid')).toBe(true); // auto-charge succeeds on creation
    expect(canTransition('awaiting_payment', 'paid')).toBe(true); // pay-link paid
    expect(canTransition('paid', 'awaiting_payment')).toBe(true); // reopen: amended up / tax restored
  });

  it('allows cancel from any non-cancelled state, including paid (→ manual refund)', () => {
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('awaiting_payment', 'cancelled')).toBe(true);
    expect(canTransition('paid', 'cancelled')).toBe(true);
  });

  it('forbids backward / terminal / nonsense transitions', () => {
    expect(canTransition('paid', 'draft')).toBe(false);
    expect(canTransition('awaiting_payment', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'paid')).toBe(false);
    expect(canTransition('paid', 'paid')).toBe(false);
  });
});

describe('invoiceStatus.asInvoiceStatus', () => {
  it('narrows valid strings and rejects the rest', () => {
    for (const s of INVOICE_STATUSES) expect(asInvoiceStatus(s)).toBe(s);
    expect(asInvoiceStatus('booked')).toBeNull();
    expect(asInvoiceStatus(42)).toBeNull();
    expect(asInvoiceStatus(null)).toBeNull();
  });
});
