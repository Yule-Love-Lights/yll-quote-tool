import { describe, it, expect, afterEach } from 'vitest';
import { friendlyPortalError, portalPhone } from './friendlyError';

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
