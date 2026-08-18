import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

// IO seams mocked (data modules, inbox reads, Telegram send, bot gating);
// collectOpsDigest + opsDigestMessage run for real so the route test exercises
// the actual assembly.
const { listQuotes, listFulfillmentCards, listOpenItems, listDueFollowUps, notifyTelegramAudience, tg } =
  vi.hoisted(() => ({
    listQuotes: vi.fn(async (): Promise<unknown[]> => []),
    listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
    listOpenItems: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false })),
    listDueFollowUps: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [] })),
    notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(),
    tg: { enabled: true, configured: true },
  }));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ listOpenItems, listDueFollowUps }));
vi.mock('@/lib/integrations/telegram', () => ({
  isTelegramBotEnabled: () => tg.enabled,
  isTelegramConfigured: () => tg.configured,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('@/lib/integrations/telegramRouting', () => ({
  notifyTelegramAudience,
}));

import { GET } from './route';

const SECRET = 'cron-secret';
function makeReq(secret?: string): NextRequest {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'authorization' && secret ? `Bearer ${secret}` : null),
    },
  } as unknown as NextRequest;
}

const draftQuote = {
  id: 'q1',
  customer_name: 'Ann Draft',
  customer_address: null,
  customer_phone: null,
  customer_email: null,
  total: 1500,
  created_at: '2026-07-01T00:00:00Z',
  quote_sent_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  viewed_at: null,
  last_viewed_at: null,
  view_count: null,
  status: null,
  decline_reason: null,
  quote_number: 101,
  is_test: false,
  service_type: null,
  legacy_rebook: false,
  view_only: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  tg.enabled = true;
  tg.configured = true;
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
  listOpenItems.mockResolvedValue({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false });
  listDueFollowUps.mockResolvedValue({ ok: true, items: [] });
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/ops/digest', () => {
  it('401s without the cron secret (and when CRON_SECRET is unset)', async () => {
    expect((await GET(makeReq())).status).toBe(401);
    expect((await GET(makeReq('wrong'))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(makeReq(SECRET))).status).toBe(401);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('skips quietly while the Telegram bot is dormant', async () => {
    tg.enabled = false;
    listQuotes.mockResolvedValue([draftQuote]);
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, skipped: 'telegram dormant' });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('still sends the heartbeat on an all-quiet day (silence would read as broken)', async () => {
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    const msg = notifyTelegramAudience.mock.calls[0][1];
    expect(msg).toContain('☀️ YLL morning digest');
    expect(msg).toContain('🔧 Installs — today: 0 · tomorrow: 0');
    expect(msg).toContain('📝 Quotes to send: 0');
  });

  it('sends the assembled digest routed to the ops audience', async () => {
    listQuotes.mockResolvedValue([draftQuote]);
    // #265: totalOpen (raw, incl. automated noise) and totalLeads (leads only)
    // deliberately DIFFER here — pins that the digest text shows totalLeads,
    // plus the residual "N filtered" (totalOpen − totalLeads = 24).
    listOpenItems.mockResolvedValue({ ok: true, items: [{}], totalOpen: 64, totalLeads: 40, truncated: true });
    listDueFollowUps.mockResolvedValue({ ok: true, items: [{}, {}] });
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0][0]).toBe('ops');
    const msg = notifyTelegramAudience.mock.calls[0][1];
    expect(msg).toContain('☀️ YLL morning digest');
    expect(msg).toContain('📝 Quotes to send: 1');
    expect(msg).toContain('📥 Inbox — 40 to respond · 24 filtered · 2 follow-ups due');
    expect(msg).not.toContain('64 to respond');
    expect(msg).toContain('→ https://quote.yulelovelights.com/admin/quotes');
    expect(msg).toContain('→ https://quote.yulelovelights.com/inbox');
    expect(msg).toContain('Dashboard → https://quote.yulelovelights.com/');
  });

  // #265: the real prod shape this fix was built for (see PR #761) — the
  // digest read 57 pre-fix, /inbox's own tile already showed 16. The
  // "N filtered" clause is what softens that cliff on the first post-merge
  // send: it self-explains where the other 41 went instead of the number
  // just silently dropping with no trace.
  it('end-to-end: the digest never shows the raw totalOpen figure, only totalLeads + what was filtered', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}], totalOpen: 57, totalLeads: 16, truncated: false });
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, sent: true });
    const msg = notifyTelegramAudience.mock.calls[0][1];
    expect(msg).toContain('📥 Inbox — 16 to respond · 41 filtered');
    expect(msg).not.toContain('57');
  });

  it('sends a failure ALERT (never goes silent) when building the digest throws', async () => {
    // The heartbeat promise: a silent morning means broken. If a data read
    // throws in a way that escapes the collectors' fail-soft, the cron must
    // still send something, not nothing.
    listQuotes.mockRejectedValue(new Error('db exploded'));
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: false, error: 'digest build failed' });
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0][0]).toBe('ops');
    expect(notifyTelegramAudience.mock.calls[0][1]).toContain('failed to build');
  });
});
