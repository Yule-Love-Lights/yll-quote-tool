import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

// IO seams mocked (data modules, Telegram send, bot gating); collectOpsDigest +
// opsDigestMessage run for real so the route test exercises the actual assembly.
const { listQuotes, listFulfillmentCards, notifyTelegramAudience, tg } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
  notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(),
  tg: { enabled: true, configured: true },
}));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));
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
};

beforeEach(() => {
  vi.clearAllMocks();
  tg.enabled = true;
  tg.configured = true;
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
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

  it('sends nothing on an all-quiet day', async () => {
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, sent: false });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('sends the assembled digest when there is something to say', async () => {
    listQuotes.mockResolvedValue([draftQuote]);
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0][0]).toBe('ops');
    const msg = notifyTelegramAudience.mock.calls[0][1];
    expect(msg).toContain('☀️ YLL morning digest');
    expect(msg).toContain('Quotes to send: 1');
    expect(msg).toContain('• #101 Ann Draft — $1,500');
    expect(msg).toContain('Admin → https://quote.yulelovelights.com/admin/quotes');
  });
});
