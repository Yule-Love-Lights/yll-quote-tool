import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// IO seams mocked; the pure logic (lowStockItems, newlyLowSkus, lowStockMessage)
// runs for real so the dedup behavior is genuinely exercised.
const { listOnHand, listCatalog, sendEmail, hlConfigured, notifyTelegramAudience, getLast, record } = vi.hoisted(() => ({
  listOnHand: vi.fn(async () => [] as { sku: string; on_hand_qty: number; reorder_point: number }[]),
  listCatalog: vi.fn(async () => [] as { sku: string; name: string }[]),
  sendEmail: vi.fn(async () => ({})),
  hlConfigured: { value: true },
  notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(),
  getLast: vi.fn(async () => [] as string[]),
  record: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => null,
}));
vi.mock('@/lib/inventory/onHand', () => ({ listOnHand }));
vi.mock('@/lib/inventory/catalog', () => ({ listCatalog }));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail,
  isHighLevelConfigured: () => hlConfigured.value,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('@/lib/integrations/telegramRouting', () => ({
  notifyTelegramAudience,
}));
vi.mock('@/lib/inventory/lowStockNotify', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/inventory/lowStockNotify')>()),
  getLastLowStockNotified: getLast,
  recordLowStockNotified: record,
}));

import { GET } from './route';

const SECRET = 'cron-secret';
function makeReq(secret?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' && secret ? `Bearer ${secret}` : null) },
  } as unknown as NextRequest;
}

const LOW_ROWS = [
  { sku: '1001', on_hand_qty: 12, reorder_point: 50 },
  { sku: '1042', on_hand_qty: 0, reorder_point: 100 },
];
const CATALOG = [
  { sku: '1001', name: 'C9 Warm White' },
  { sku: '1042', name: 'Green clips' },
];

beforeEach(() => {
  vi.clearAllMocks();
  hlConfigured.value = true;
  listOnHand.mockResolvedValue(LOW_ROWS);
  listCatalog.mockResolvedValue(CATALOG);
  getLast.mockResolvedValue([]);
  process.env.CRON_SECRET = SECRET;
  process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  delete process.env.TELEGRAM_BOT_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('low-stock-alert — Telegram ping (#82 follow-up)', () => {
  it('pings the group with the newly-low items and records the baseline', async () => {
    getLast.mockResolvedValue([]); // nothing reported yet → both are new
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0][0]).toBe('inventory');
    const msg = notifyTelegramAudience.mock.calls[0][1] as string;
    expect(msg).toContain('Low stock');
    expect(msg).toContain('C9 Warm White (1001): 12 on hand (reorder 50)');
    expect(msg).toContain('Green clips (1042): 0 on hand (reorder 100)');
    expect(record).toHaveBeenCalledWith(['1001', '1042']);
  });

  it('does NOT ping when nothing is newly low, but still records the current set', async () => {
    getLast.mockResolvedValue(['1001', '1042']); // both already reported
    await GET(makeReq(SECRET));
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(['1001', '1042']);
  });

  it('only pings the SKU that newly crossed the threshold', async () => {
    getLast.mockResolvedValue(['1001']); // 1001 already known, 1042 is new
    await GET(makeReq(SECRET));
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    const msg = notifyTelegramAudience.mock.calls[0][1] as string;
    expect(msg).toContain('Green clips (1042)');
    expect(msg).not.toContain('C9 Warm White (1001)');
  });

  it('does not ping or consume the baseline when the bot is disabled', async () => {
    delete process.env.TELEGRAM_BOT_ENABLED;
    await GET(makeReq(SECRET));
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('401s without the cron secret (no work done)', async () => {
    const res = await GET(makeReq('wrong'));
    expect(res.status).toBe(401);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });
});
