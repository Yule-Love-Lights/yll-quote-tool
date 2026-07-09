import { describe, it, expect } from 'vitest';
import { isPublicPath } from './operatorGate';

describe('isPublicPath — customer-facing allowlist', () => {
  it('treats the customer portal + its assets as public', () => {
    for (const p of [
      '/portal',
      '/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60',
      '/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/approved',
      '/photos/abc.png',
      '/login',
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('treats every customer-triggered quote API as public', () => {
    // The portal lets the customer approve, pay, view, decline, request changes,
    // and signal interest — all gated only by the quote UUID, never operator auth.
    // Missing any one of these 401s a real customer once the gate is enabled.
    for (const sub of ['approve', 'pay', 'pay-balance', 'view', 'decline', 'request-changes', 'interested', 'simulate-deposit']) {
      const p = `/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/${sub}`;
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('treats public webhooks + crons + the login API as public', () => {
    for (const p of [
      '/api/login',
      '/api/health', // uptime monitor probe — booleans only, no PII/secrets (#81 W6-001)
      '/api/integrations/valor/webhook',
      '/api/integrations/homeworks/signed',
      '/api/integrations/whatsapp/webhook', // Twilio webhook (signature-verified in the route, #82)
      '/api/integrations/telegram/webhook', // Telegram Bot webhook (secret-token verified, #82)
      '/api/inventory/purchase-order/auto-send', // Vercel Cron (CRON_SECRET-guarded, #82)
      '/api/inventory/low-stock-alert', // Vercel Cron (CRON_SECRET-guarded, #82)
      '/api/dashboard/ghl/reconcile', // Vercel Cron (CRON_SECRET-guarded, #58)
      '/api/dashboard/ghl/webhook', // GHL webhook (shared-secret in the route, #58)
      '/api/dashboard/escalate', // Vercel Cron (CRON_SECRET-guarded, #58)
      '/api/dashboard/quotetool/reconcile', // Vercel Cron (CRON_SECRET-guarded, #58)
      '/api/dashboard/gmail/poll', // Vercel Cron (CRON_SECRET-guarded, #58)
      '/api/dashboard/ingest', // Generic ingest (shared-secret in the route, #58)
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('gates every operator page + write API (default-deny)', () => {
    for (const p of [
      '/',
      '/customers',
      '/customers/contact_123',
      '/admin/quotes',
      '/settings',
      '/quote/new',
      '/training',
      '/insights',
      '/inventory',
      '/api/quotes', // list — PII
      '/api/settings',
      '/api/designs',
      '/api/designs/abc',
      '/api/training',
      '/api/integrations/highlevel/contacts', // CRITICAL #2
      '/api/integrations/highlevel/attach',
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/send', // operator action
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/video', // operator-managed
      '/api/inbox', // #58 operator-only open-items feed
      '/api/dashboard/handled', // #58 operator action
      '/api/dashboard/dismiss', // #58 operator action
      '/api/dashboard/followup', // #58 operator action (mark follow-up done)
      '/api/inventory/materials', // sibling inventory route — must stay operator-only
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('tolerates a single trailing slash on public paths', () => {
    for (const p of [
      '/login/',
      '/api/login/',
      '/api/integrations/whatsapp/webhook/',
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/approve/',
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('does not let a crafted path masquerade as a public sub-route', () => {
    // extra segments must not match the customer-subroute rule
    expect(isPublicPath('/api/quotes/x/approve/extra')).toBe(false);
    expect(isPublicPath('/api/quotesX/y/approve')).toBe(false);
    expect(isPublicPath('/api/quotes/y/delete')).toBe(false);
    expect(isPublicPath('/api/quotes/y/send')).toBe(false); // operator action, not customer
  });

  it('treats /api/health as public (uptime monitor probe, #81 W6-001)', () => {
    expect(isPublicPath('/api/health')).toBe(true);
  });

  it('allows bare GET /api/quotes/<id> (capability-token portal read) but keeps DELETE operator-only (#81 W6-005)', () => {
    const p = '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // method defaults to GET
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(p, 'POST')).toBe(false);
  });

  it('allows GET /api/inventory/offered-colors (anonymous portal color picker) but keeps other methods operator-only (#469 / S26)', () => {
    const p = '/api/inventory/offered-colors';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // method defaults to GET
    expect(isPublicPath(p, 'POST')).toBe(false);
    expect(isPublicPath(`${p}/`, 'GET')).toBe(true); // tolerates a single trailing slash
  });
});
