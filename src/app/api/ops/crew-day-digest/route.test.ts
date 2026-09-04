// Daily crew schedule notification. IO seams mocked; the pure message builder
// runs for real, so what the crew would actually receive is what is asserted.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cronDenial, isSupabaseServiceConfigured, isTelegramBotEnabled, isTelegramConfigured, notifyTelegramAudience, getCrewDay } =
  vi.hoisted(() => ({
    cronDenial: vi.fn(),
    isSupabaseServiceConfigured: vi.fn(),
    isTelegramBotEnabled: vi.fn(),
    isTelegramConfigured: vi.fn(),
    notifyTelegramAudience: vi.fn(),
    getCrewDay: vi.fn(),
  }));

vi.mock('@/lib/auth/cronAuth', () => ({ cronDenial }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured }));
vi.mock('@/lib/integrations/telegram', () => ({ isTelegramBotEnabled, isTelegramConfigured }));
vi.mock('@/lib/integrations/telegramRouting', () => ({ notifyTelegramAudience }));
vi.mock('@/lib/crew/dayDigestData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crew/dayDigestData')>();
  return { ...actual, getCrewDay };
});

import { NextRequest } from 'next/server';
import { GET } from './route';

const req = () => new NextRequest('https://quote.example.com/api/ops/crew-day-digest');
const sentText = () => notifyTelegramAudience.mock.calls[0]![1] as string;

beforeEach(() => {
  vi.clearAllMocks();
  cronDenial.mockReturnValue(null);
  isSupabaseServiceConfigured.mockReturnValue(true);
  isTelegramBotEnabled.mockReturnValue(true);
  isTelegramConfigured.mockReturnValue(true);
  getCrewDay.mockResolvedValue({
    date: '2026-09-04',
    jobs: [
      {
        jobNumber: 1069,
        customerName: 'naldoventest',
        address: '6 Birch Road, Amityville, NY',
        status: 'to_schedule',
        crew: ['Little James', 'Naldo', 'SonSon'],
      },
    ],
    errors: [],
  });
});

describe('GET /api/ops/crew-day-digest', () => {
  it('sends one block per job, with the crew under it, to the crew audience', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    const [audience, text] = notifyTelegramAudience.mock.calls[0]!;
    // NOT 'jobs': that audience also carries installment-run charge summaries.
    expect(audience).toBe('crew');
    expect(text).toContain('#1069 naldoventest, 6 Birch Road, Amityville, NY');
    expect(text).toMatch(/Little James\nNaldo\nSonSon/);
    // The job appears ONCE, however many people are on it.
    expect((text as string).match(/#1069/g)).toHaveLength(1);
  });

  it('counts the day for the cron log: jobs, and distinct people', async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, jobCount: 1, crewCount: 3, unassignedCount: 0 });
  });

  it('counts a job nobody is on as unassigned', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-09-04',
      jobs: [{ jobNumber: 1070, customerName: null, address: '9 Elm St', status: null, crew: [] }],
      errors: [],
    });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ jobCount: 1, crewCount: 0, unassignedCount: 1 });
    expect(sentText()).toMatch(/[Nn]obody assigned/);
  });

  it('refuses without the cron secret and sends nothing', async () => {
    cronDenial.mockReturnValue(new Response('no', { status: 401 }));
    await GET(req());
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('503s with no Supabase service role, before any send', async () => {
    isSupabaseServiceConfigured.mockReturnValue(false);
    expect((await GET(req())).status).toBe(503);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('stays quiet when the bot is dormant rather than erroring', async () => {
    isTelegramBotEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'telegram dormant' });
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('still sends an all-clear on an empty day', async () => {
    getCrewDay.mockResolvedValue({ date: '2026-09-04', jobs: [], errors: [] });
    await GET(req());
    expect(sentText()).toContain('Nothing on the schedule');
  });

  // The failure that matters most: a total read failure empties the day, and an
  // all-clear on a busy morning is worse than no message at all.
  it('never announces an all-clear when the read failed', async () => {
    getCrewDay.mockResolvedValue({ date: '2026-09-04', jobs: [], errors: ['assignment scan: connection reset'] });
    await GET(req());
    expect(sentText()).not.toContain('Nothing on the schedule');
    expect(sentText()).toMatch(/could not read the schedule/i);
  });

  it('warns inside the MESSAGE on a partial read, not only in the JSON', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-09-04',
      jobs: [{ jobNumber: 1046, customerName: null, address: null, status: null, crew: ['Naldo'] }],
      errors: ['property lookup: boom'],
    });
    const body = await (await GET(req())).json();
    expect(sentText()).toMatch(/may be incomplete/i);
    expect(body.errors).toEqual(['property lookup: boom']);
  });
});
