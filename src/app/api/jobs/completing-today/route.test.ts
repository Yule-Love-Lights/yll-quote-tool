import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { nyDateString } from '@/lib/jobs/completingToday';

const TODAY = nyDateString();

// IO seams mocked; the pure logic (filterCompletingToday, completingTodayMessage)
// runs for real. isTelegramBotEnabled/isTelegramConfigured are left real (pure
// env-var checks, same as the other cron route tests).
const { getSupabaseServiceClient, isSupabaseServiceConfigured, notifyTelegramAudience } = vi.hoisted(() => ({
  getSupabaseServiceClient: vi.fn(),
  isSupabaseServiceConfigured: vi.fn(() => true),
  notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient, isSupabaseServiceConfigured }));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('@/lib/integrations/telegramRouting', () => ({ notifyTelegramAudience }));

import { GET } from './route';

const SECRET = 'cron-secret';
function makeReq(secret?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' && secret ? `Bearer ${secret}` : null) },
  } as unknown as NextRequest;
}

type JobRow = { id: string; job_number: number | null; quote_id: string | null; status: string; install_date: string | null };
type QuoteRow = { id: string; customer_name: string | null; customer_address: string | null };

function makeDb(jobsRows: JobRow[], quotesRows: QuoteRow[] = []) {
  return {
    from: (table: string) => {
      if (table === 'jobs') {
        return { select: () => ({ eq: async () => ({ data: jobsRows, error: null }) }) };
      }
      if (table === 'quotes') {
        return { select: () => ({ in: async () => ({ data: quotesRows, error: null }) }) };
      }
      throw new Error('unexpected table ' + table);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSupabaseServiceConfigured.mockReturnValue(true);
  getSupabaseServiceClient.mockReturnValue(makeDb([]));
  process.env.CRON_SECRET = SECRET;
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.TELEGRAM_BOT_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('jobs completing-today cron', () => {
  it('401s without the cron secret (no work done)', async () => {
    const res = await GET(makeReq('wrong'));
    expect(res.status).toBe(401);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    isSupabaseServiceConfigured.mockReturnValue(false);
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(503);
  });

  it('sends nothing (silent) when no jobs match today — still 200s with matched: 0', async () => {
    getSupabaseServiceClient.mockReturnValue(makeDb([]));
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: 0 });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('excludes done/cancelled jobs even when install_date matches today', async () => {
    getSupabaseServiceClient.mockReturnValue(
      makeDb([
        { id: '1', job_number: 1, quote_id: null, status: 'done', install_date: TODAY },
        { id: '2', job_number: 2, quote_id: null, status: 'cancelled', install_date: TODAY },
      ]),
    );
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, matched: 0 });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('pings the Jobs chat with matching jobs, joined customer name + address', async () => {
    getSupabaseServiceClient.mockReturnValue(
      makeDb(
        [{ id: '1', job_number: 55, quote_id: 'q1', status: 'scheduled', install_date: TODAY }],
        [{ id: 'q1', customer_name: 'Carol', customer_address: '9 Elm St' }],
      ),
    );
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: 1 });
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0][0]).toBe('jobs');
    const msg = notifyTelegramAudience.mock.calls[0][1] as string;
    expect(msg).toContain('#55 Carol — 9 Elm St');
    expect(msg).toContain('Jobs → https://quote.yulelovelights.com/admin/jobs');
  });

  it('still reports the match count but does not ping when the bot is disabled', async () => {
    delete process.env.TELEGRAM_BOT_ENABLED;
    getSupabaseServiceClient.mockReturnValue(
      makeDb([{ id: '1', job_number: 1, quote_id: null, status: 'scheduled', install_date: TODAY }]),
    );
    const res = await GET(makeReq(SECRET));
    expect(await res.json()).toEqual({ ok: true, matched: 1 });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('502s when the jobs query errors', async () => {
    getSupabaseServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'jobs') return { select: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) };
        throw new Error('unexpected table ' + table);
      },
    });
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(502);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });
});
