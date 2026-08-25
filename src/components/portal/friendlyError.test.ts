import { describe, it, expect, afterEach } from 'vitest';
import { invoiceStaleError, friendlyPortalError, portalPhone, viewOnlyStaleTabError, nceBalanceBlockedError } from './friendlyError';

// #90 / audit g10: customer-facing portal errors must never surface the raw
// server/network error (Supabase/Postgres internals, "Failed to fetch", HTTP
// codes). This pure helper is the no-leak guard — it only takes a human action
// phrase, so a raw error physically cannot pass through it.

describe('friendlyPortalError', () => {
  it('returns recoverable copy naming the action and the contact phone', () => {
    const msg = friendlyPortalError('start checkout', '(555) 000-1234');
    expect(msg).toContain('start checkout');
    expect(msg).toContain('(555) 000-1234');
    expect(msg.toLowerCase()).toContain('try again');
  });

  it('cannot echo a raw server/network error (no leak by construction)', () => {
    const msg = friendlyPortalError('start checkout', '(555) 000-1234');
    expect(msg).not.toMatch(/supabase|postgres|failed to fetch|http \d|service role/i);
  });
});

describe('portalPhone', () => {
  const OLD = process.env.NEXT_PUBLIC_PORTAL_PHONE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
    else process.env.NEXT_PUBLIC_PORTAL_PHONE = OLD;
  });

  it('falls back to the default when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
    expect(portalPhone()).toBe('(631) 517-0186');
  });

  it('uses the configured phone when set', () => {
    process.env.NEXT_PUBLIC_PORTAL_PHONE = '(555) 111-2222';
    expect(portalPhone()).toBe('(555) 111-2222');
  });
});

// #176 — the stale-tab view-only 409 copy must never suggest retrying will work.
describe('viewOnlyStaleTabError', () => {
  it('names the browse-only state and the contact phone', () => {
    const msg = viewOnlyStaleTabError('(555) 000-1234');
    expect(msg).toContain('browse-only');
    expect(msg).toContain('(555) 000-1234');
  });

  it('never suggests retrying will succeed (unlike friendlyPortalError)', () => {
    const msg = viewOnlyStaleTabError('(555) 000-1234');
    expect(msg.toLowerCase()).not.toContain('try again');
  });

  it('defaults to portalPhone() when no phone is passed', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
    expect(viewOnlyStaleTabError()).toContain('(631) 517-0186');
  });
});

// #199 — the pay-balance 409 copy for an NCE-tagged quote.
describe('nceBalanceBlockedError', () => {
  it('names the NCE trade-account state and the contact phone', () => {
    const msg = nceBalanceBlockedError('(555) 000-1234');
    expect(msg).toContain('NCE trade account');
    expect(msg).toContain('(555) 000-1234');
  });

  it('never suggests retrying will succeed (unlike friendlyPortalError)', () => {
    const msg = nceBalanceBlockedError('(555) 000-1234');
    expect(msg.toLowerCase()).not.toContain('try again');
  });

  it('defaults to portalPhone() when no phone is passed', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
    expect(nceBalanceBlockedError()).toContain('(631) 517-0186');
  });
});
// Row 378 — the pay-balance 409 copy for an invoice that no longer reconciles
// with the order's agreed total. Same "name the real state, don't say retry"
// family as the two above.
describe('invoiceStaleError', () => {
  it('names the real state and the contact phone', () => {
    const msg = invoiceStaleError('(555) 000-1234');
    expect(msg).toContain('confirm the final amount');
    expect(msg).toContain('(555) 000-1234');
  });

  it('never suggests retrying will succeed (retrying cannot clear a stale invoice)', () => {
    const msg = invoiceStaleError('(555) 000-1234');
    expect(msg.toLowerCase()).not.toContain('try again');
  });

  // The customer must never be shown the mechanism, and must never be shown a
  // dollar figure here — the whole reason we refused is that we do not yet know
  // which figure is right.
  it('leaks neither the mechanism nor any dollar amount', () => {
    const msg = invoiceStaleError('(555) 000-1234');
    expect(msg).not.toMatch(/invoice|sync|stale|amend|CAS/i);
    expect(msg).not.toMatch(/\$\s*\d/);
  });

  // The route fires a best-effort staff ping that no-ops when the Telegram bot
  // is dormant — so this copy must not promise the customer that anyone was
  // told. It states what has to happen and gives a channel that always works.
  it('does not claim staff have already been notified', () => {
    const msg = invoiceStaleError('(555) 000-1234');
    expect(msg).not.toMatch(/notified|we've let|our team has been|alerted/i);
  });

  it('defaults to portalPhone() when no phone is passed', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_PHONE;
    expect(invoiceStaleError()).toContain('(631) 517-0186');
  });
});
