import { afterEach, describe, expect, it } from 'vitest';

import { redactCustomerRef } from './route';

const SECRET = 'a'.repeat(48);
const CUSTOMER = '8f3a1c2e-0000-4000-8000-000000000001';

afterEach(() => { delete process.env.OPS_HUB_CUSTOMER_REF_SECRET; });

// Naldo's call 2026-08-25. customer_ref is the primary key of public.customers,
// which holds name, email and phone, so it is a re-identification key rather
// than an opaque token. This is the ONE boundary it would leave through, and a
// review flagged that the guarantee was correct by inspection but unguarded.
describe('redactCustomerRef', () => {
  it('replaces the raw customer id with a hash', () => {
    process.env.OPS_HUB_CUSTOMER_REF_SECRET = SECRET;
    const out = redactCustomerRef({ quote_number: 1276, customer_ref: CUSTOMER, total_cents: 779738 });
    expect(out.customer_ref).toBeUndefined();
    expect(typeof out.customer_ref_hash).toBe('string');
    expect(JSON.stringify(out)).not.toContain(CUSTOMER);
  });

  it('leaves every other field untouched', () => {
    process.env.OPS_HUB_CUSTOMER_REF_SECRET = SECRET;
    const out = redactCustomerRef({ quote_number: 1276, customer_ref: CUSTOMER, total_cents: 779738 });
    expect(out.quote_number).toBe(1276);
    expect(out.total_cents).toBe(779738);
  });

  // The one that matters: a missing secret must DROP the field, never fall back.
  it('omits the field entirely when no secret is configured', () => {
    delete process.env.OPS_HUB_CUSTOMER_REF_SECRET;
    const out = redactCustomerRef({ quote_number: 1276, customer_ref: CUSTOMER });
    expect(out.customer_ref).toBeUndefined();
    expect(out.customer_ref_hash).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(CUSTOMER);
  });

  it('is a no-op on a payload that carries no customer_ref', () => {
    process.env.OPS_HUB_CUSTOMER_REF_SECRET = SECRET;
    expect(redactCustomerRef({ quote_number: 1276 })).toEqual({ quote_number: 1276 });
  });
});
