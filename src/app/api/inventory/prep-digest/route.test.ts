import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the pure logic (prepDigestMessage) runs for real.
const { listFulfillmentCards, notifyTelegram } = vi.hoisted(() => ({
  listFulfillmentCards: vi.fn(async () => [] as FulfillmentCard[]),
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));

import { GET } from './route';

const SECRET = 'cron-secret';
function makeReq(secret?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' && secret ? `Bearer ${secret}` : null) },
  } as unknown as NextRequest;
}

function card(over: Partial<FulfillmentCard>): FulfillmentCard {
  return {
    id: 'id-1',
    jobNumber: 1,
    quoteId: null,
    designId: null,
    stage: 'to_be_ordered',
    status: 'to_schedule',
    customerName: 'Jane Doe',
    customerAddress: null,
    itemCount: 0,
    installDate: null,
    isTest: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listFulfillmentCards.mockResolvedValue([]);
  process.env.CRON_SECRET = SECRET;
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.TELEGRAM_BOT_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('inventory prep-digest cron', () => {
  it('401s without the cron secret (no work done)', async () => {
    const res = await GET(makeReq('wrong'));
    expect(res.status).toBe(401);
    expect(notifyTelegram).not.toHaveBeenCalled();
  });

  it('sends the all-clear when nothing is waiting', async () => {
    listFulfillmentCards.mockResolvedValue([]);
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifyTelegram.mock.calls[0][0]).toBe('✅ Prep board clear — nothing waiting.');
  });

  it('sends the grouped digest, reusing the SAME cards the board reads', async () => {
    listFulfillmentCards.mockResolvedValue([
      card({ jobNumber: 42, customerName: 'Alice', stage: 'to_be_ordered' }),
      card({ jobNumber: 43, customerName: 'Bob', stage: 'ready_for_install' }), // not prep — excluded
    ]);
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    const msg = notifyTelegram.mock.calls[0][0] as string;
    expect(msg).toContain('#42 Alice');
    expect(msg).not.toContain('#43 Bob');
    expect(msg).toContain('Board → https://quote.yulelovelights.com/inventory/jobs');
  });

  it('does not ping when the bot is disabled', async () => {
    delete process.env.TELEGRAM_BOT_ENABLED;
    await GET(makeReq(SECRET));
    expect(notifyTelegram).not.toHaveBeenCalled();
    expect(listFulfillmentCards).not.toHaveBeenCalled();
  });
});
