import { describe, it, expect } from 'vitest';
import { isCrewPath, isPublicPath } from './operatorGate';

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
    for (const sub of ['approve', 'amend-consent', 'pay', 'pay-balance', 'view', 'decline', 'request-changes', 'interested', 'simulate-deposit']) {
      const p = `/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/${sub}`;
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('treats public webhooks + crons + the login API as public', () => {
    for (const p of [
      '/api/login',
      '/api/health', // uptime monitor probe — booleans only, no PII/secrets (#81 W6-001)
      '/api/integrations/valor/webhook',
      '/api/integrations/valor/redirect-capture', // #161 diagnostic probe — Valor's redirect_url S2S callback (values never logged, see route header)
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
      '/api/leads/retry', // Vercel Cron (CRON_SECRET-guarded, #leads retry worker)
      '/api/ops/digest', // Vercel Cron (CRON_SECRET-guarded, #168 morning ops digest)
      '/api/inventory/prep-digest', // Vercel Cron (CRON_SECRET-guarded, #666 daily prep digest)
      '/api/jobs/completing-today', // Vercel Cron (CRON_SECRET-guarded, #666 completing-today Jobs ping)
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('allows GET + POST /api/integrations/valor/redirect-capture (#161 diagnostic probe — redirect_url S2S callback, values never logged)', () => {
    const p = '/api/integrations/valor/redirect-capture';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p, 'POST')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // method defaults to GET
  });

  it('keeps the admin leads surface operator-only — only the cron is public (#leads)', () => {
    // The retry CRON must reach its own CRON_SECRET check (Vercel cron carries no
    // operator session), so it's allowlisted above. The ADMIN list + manual-retry
    // routes are requireAdmin — an operator hits them WITH a session, so they must
    // stay default-denied here (never public).
    expect(isPublicPath('/api/leads/retry', 'GET')).toBe(true);
    expect(isPublicPath('/api/admin/leads', 'GET')).toBe(false);
    expect(isPublicPath('/api/admin/leads/abc-123/retry', 'POST')).toBe(false);
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

  it('treats the referral landing page as public (ledger #41)', () => {
    for (const p of ['/refer', '/refer/ABCD1234', '/refer/not-a-real-code']) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('allows POST /api/referrals/submit (referral landing page lead form) but keeps other methods operator-only (#41)', () => {
    const p = '/api/referrals/submit';
    expect(isPublicPath(p, 'POST')).toBe(true);
    expect(isPublicPath(p, 'GET')).toBe(false);
    expect(isPublicPath(p)).toBe(false); // method defaults to GET, which is NOT allowlisted here
    expect(isPublicPath(`${p}/`, 'POST')).toBe(true); // tolerates a single trailing slash
  });

  it('allows POST + OPTIONS /api/leads (website lead form, cross-origin) but keeps other methods operator-only (#leads)', () => {
    const p = '/api/leads';
    expect(isPublicPath(p, 'POST')).toBe(true);
    expect(isPublicPath(p, 'OPTIONS')).toBe(true); // CORS preflight from yulelovelights.com
    expect(isPublicPath(p, 'GET')).toBe(false);
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(p)).toBe(false); // method defaults to GET, which is NOT allowlisted here
    expect(isPublicPath(`${p}/`, 'POST')).toBe(true); // tolerates a single trailing slash
  });

  // Regression (production, S42): the partial endpoint shipped in #584 without
  // an allowlist entry, so the default-deny gate 401'd every real visitor's
  // abandoned-form capture. It looked fine in testing only because an operator's
  // own session sailed through the gate.
  it('allows POST + OPTIONS /api/leads/partial (abandoned-form capture, cross-origin) but keeps other methods operator-only (#leads)', () => {
    const p = '/api/leads/partial';
    expect(isPublicPath(p, 'POST')).toBe(true);
    expect(isPublicPath(p, 'OPTIONS')).toBe(true); // route defines an OPTIONS handler for CORS
    expect(isPublicPath(p, 'GET')).toBe(false);
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(p)).toBe(false); // method defaults to GET, which is NOT allowlisted here
    expect(isPublicPath(`${p}/`, 'POST')).toBe(true); // tolerates a single trailing slash
  });

  it('does NOT open any other /api/leads sub-path (the carve-out stays exact)', () => {
    expect(isPublicPath('/api/leads/nonexistent', 'POST')).toBe(false);
    expect(isPublicPath('/api/leads/partial/deeper', 'POST')).toBe(false);
    // sibling operator/admin surfaces stay gated
    expect(isPublicPath('/api/admin/leads', 'POST')).toBe(false);
  });

  // Both shipped public by their route authors, neither has an operator gate of
  // its own, and both were missed here — so a real customer got 401 while any
  // logged-in operator saw them work. Found by the derived publicSurface guard.
  it('allows GET /api/quotes/<id>/pdf (customer quote/invoice/receipt downloads) but no other method', () => {
    const p = '/api/quotes/11111111-2222-4333-8444-555555555555/pdf';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // href link, method defaults to GET
    expect(isPublicPath(p, 'POST')).toBe(false);
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(`${p}/`, 'GET')).toBe(true);
  });

  it('allows POST /api/quotes/<id>/color-change-request (#163 booked colour change) but no other method', () => {
    const p = '/api/quotes/11111111-2222-4333-8444-555555555555/color-change-request';
    expect(isPublicPath(p, 'POST')).toBe(true);
    expect(isPublicPath(p, 'GET')).toBe(false);
    expect(isPublicPath(p)).toBe(false); // default GET is NOT allowlisted here
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(`${p}/`, 'POST')).toBe(true);
  });

  it('the method-scoped quote carve-outs do not leak to other sub-paths or depths', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(isPublicPath(`/api/quotes/${id}/pdf/raw`, 'GET')).toBe(false);
    expect(isPublicPath(`/api/quotes/${id}/send`, 'POST')).toBe(false); // operator action
    expect(isPublicPath(`/api/quotes/${id}/color-change-request/approve`, 'POST')).toBe(false);
    expect(isPublicPath('/api/pdf', 'GET')).toBe(false);
  });

  // #611 tightened the self-serve gate from a prefix to an EXACT match, so the
  // old prefix test (which asserted /estimate/anything is public) is replaced.
  it('treats the self-serve estimate page as public — EXACT match only (ledger self-serve, Phase A)', () => {
    expect(isPublicPath('/estimate')).toBe(true);
    expect(isPublicPath('/estimate/')).toBe(true); // single trailing slash is normalized
    // A hypothetical sub-path must NOT be public by prefix — it has to be
    // allowlisted deliberately (defense-in-depth, review 2026-07-20).
    expect(isPublicPath('/estimate/anything')).toBe(false);
  });

  it('allows POST /api/estimate + /api/estimate/contact + /api/estimate/upload but keeps other methods operator-only (self-serve Phase A)', () => {
    for (const p of ['/api/estimate', '/api/estimate/contact', '/api/estimate/upload']) {
      expect(isPublicPath(p, 'POST'), p).toBe(true);
      expect(isPublicPath(p, 'GET'), p).toBe(false);
      expect(isPublicPath(p), p).toBe(false); // method defaults to GET, which is NOT allowlisted here
      expect(isPublicPath(`${p}/`, 'POST'), p).toBe(true); // tolerates a single trailing slash
    }
  });

  it('allows GET /api/estimate/design (result-screen visual poll) but keeps other methods operator-only (self-serve Slice 3)', () => {
    const p = '/api/estimate/design';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // method defaults to GET
    expect(isPublicPath(p, 'POST')).toBe(false);
    expect(isPublicPath(p, 'DELETE')).toBe(false);
    expect(isPublicPath(`${p}/`, 'GET')).toBe(true); // tolerates a single trailing slash
  });

  it('allows GET /api/estimate/samples (featured real-job gallery) but keeps other methods operator-only (self-serve S48)', () => {
    const p = '/api/estimate/samples';
    expect(isPublicPath(p, 'GET')).toBe(true);
    expect(isPublicPath(p)).toBe(true); // method defaults to GET
    expect(isPublicPath(p, 'POST')).toBe(false);
    expect(isPublicPath(`${p}/`, 'GET')).toBe(true); // tolerates a single trailing slash
  });

  // #195 — the non-lead website forms are iframed on yulelovelights.com, so the
  // visitor is never signed in. Without these entries the perimeter
  // default-denies and a homeowner sees our login screen instead of the form.
  // Caught on PROD after merge, by neither review lens (S50).
  it('treats each non-lead form page as public — EXACT match only (#195)', () => {
    for (const p of ['/forms/newsletter', '/forms/careers', '/forms/intern', '/forms/nomination']) {
      expect(isPublicPath(p), p).toBe(true);
      expect(isPublicPath(`${p}/`), p).toBe(true); // single trailing slash is normalized
    }
    // Never public by prefix: a future /forms/<something> is a deliberate act.
    expect(isPublicPath('/forms')).toBe(false);
    expect(isPublicPath('/forms/anything-else')).toBe(false);
    expect(isPublicPath('/forms/newsletter/extra')).toBe(false);
  });

  it('allows POST + OPTIONS on /api/site-forms and nothing else (#195)', () => {
    expect(isPublicPath('/api/site-forms', 'POST')).toBe(true);
    expect(isPublicPath('/api/site-forms', 'OPTIONS')).toBe(true); // cross-origin JSON preflight
    expect(isPublicPath('/api/site-forms/', 'POST')).toBe(true);
    expect(isPublicPath('/api/site-forms', 'GET')).toBe(false);
    expect(isPublicPath('/api/site-forms', 'DELETE')).toBe(false);
    expect(isPublicPath('/api/site-forms')).toBe(false); // defaults to GET
    // The ADMIN read of the same data stays operator-only.
    expect(isPublicPath('/api/admin/site-forms', 'GET')).toBe(false);
    expect(isPublicPath('/admin/site-forms')).toBe(false);
  });
});

describe('isCrewPath — the crew-only surface (row 279)', () => {
  it('claims the whole /api/ops/v1 namespace', () => {
    expect(isCrewPath('/api/ops/v1')).toBe(true);
    expect(isCrewPath('/api/ops/v1/jobs/abc/arrive')).toBe(true);
    expect(isCrewPath('/api/ops/v1/jobs/abc/depart')).toBe(true);
    expect(isCrewPath('/api/ops/v1/jobs/abc/complete')).toBe(true);
    // Not yet built, but the prefix must already cover it so adding it needs no
    // change here.
    expect(isCrewPath('/api/ops/v1/breaks/start')).toBe(true);
  });

  it('tolerates a trailing slash', () => {
    expect(isCrewPath('/api/ops/v1/')).toBe(true);
  });

  it('does NOT claim /api/ops paths outside v1 — the crons are not crew', () => {
    expect(isCrewPath('/api/ops/digest')).toBe(false);
    expect(isCrewPath('/api/ops/midnight-close')).toBe(false);
    expect(isCrewPath('/api/ops')).toBe(false);
  });

  it('does not claim the operator surface, which is the whole point', () => {
    // A crew session reaching any of these would be reaching customer PII.
    expect(isCrewPath('/customers')).toBe(false);
    expect(isCrewPath('/api/customers')).toBe(false);
    expect(isCrewPath('/admin/jobs')).toBe(false);
    expect(isCrewPath('/api/jobs')).toBe(false);
    expect(isCrewPath('/')).toBe(false);
  });

  it('is not fooled by a lookalike prefix', () => {
    expect(isCrewPath('/api/ops/v1x/jobs')).toBe(false);
    expect(isCrewPath('/api/ops/v10/jobs')).toBe(false);
  });
});

describe('the crew API is NOT public — it needs a session, just a crew one', () => {
  it('keeps every crew path out of the public allowlist', () => {
    for (const p of [
      '/api/ops/v1',
      '/api/ops/v1/jobs/abc/arrive',
      '/api/ops/v1/jobs/abc/depart',
      '/api/ops/v1/jobs/abc/complete',
    ]) {
      expect(isPublicPath(p, 'POST')).toBe(false);
      expect(isPublicPath(p, 'GET')).toBe(false);
    }
  });

  it('DOES allowlist the midnight-close cron, which carries no session at all', () => {
    // Without this the perimeter 401s the cron before its own CRON_SECRET check
    // runs — the exact gap that silently broke prep-digest and the morning digest.
    expect(isPublicPath('/api/ops/midnight-close', 'POST')).toBe(true);
    expect(isPublicPath('/api/ops/midnight-close', 'GET')).toBe(true);
  });
});
