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

beforeEach(() => {
  vi.clearAllMocks();
  cronDenial.mockReturnValue(null);
  isSupabaseServiceConfigured.mockReturnValue(true);
  isTelegramBotEnabled.mockReturnValue(true);
  isTelegramConfigured.mockReturnValue(true);
  getCrewDay.mockResolvedValue({
    date: '2026-08-29',
    groups: [
      { crewName: 'Field Crew One', jobs: [{ jobNumber: 1046, address: '123 Birch Hill Rd', status: 'to_schedule', customerName: null, otherCrew: [] }] },
    ],
    unassigned: [{ jobNumber: 1051, address: '12 Oak Rd', status: 'to_schedule', customerName: null, otherCrew: [] }],
    jobCount: 2,
    errors: [],
  });
});

describe('GET /api/ops/crew-day-digest', () => {
  it('sends the day to the jobs audience with the real message text', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    const [audience, text] = notifyTelegramAudience.mock.calls[0]!;
    // NOT 'jobs': that audience also carries installment-run charge summaries.
    expect(audience).toBe('crew');
    expect(text).toContain('Field Crew One');
    expect(text).toContain('#1046');
    expect(text).toContain('123 Birch Hill Rd');
    expect(text).toMatch(/[Nn]obody assigned/);
  });

  it('counts what it sent, so the cron log shows the day at a glance', async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, crewCount: 1, jobCount: 2, unassignedCount: 1 });
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

  // Silence must always mean the cron failed, never "nothing today".
  it('still sends an all-clear on an empty day', async () => {
    getCrewDay.mockResolvedValue({ date: '2026-08-29', groups: [], unassigned: [], jobCount: 0, errors: [] });
    await GET(req());
    expect(notifyTelegramAudience.mock.calls[0]![1]).toContain('Nothing on the schedule');
  });

  it('still sends on a partial read, and reports what was incomplete', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-08-29',
      groups: [{ crewName: 'Field Crew One', jobs: [{ jobNumber: 1046, address: null, status: null, customerName: null, otherCrew: [] }] }],
      unassigned: [],
      jobCount: 1,
      errors: ['property lookup: boom'],
    });
    const body = await (await GET(req())).json();
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(body.errors).toEqual(['property lookup: boom']);
  });

  // The failure mode that matters most: a total read failure empties the day,
  // and an all-clear on a busy morning is worse than no message at all.
  it('never announces an all-clear when the read failed', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-08-29',
      groups: [],
      unassigned: [],
      jobCount: 0,
      errors: ['assignment scan: connection reset'],
    });
    await GET(req());
    const text = notifyTelegramAudience.mock.calls[0]![1] as string;
    expect(text).not.toContain('Nothing on the schedule');
    expect(text).toMatch(/could not read the schedule/i);
  });

  it('warns inside the MESSAGE on a partial read, not only in the JSON', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-08-29',
      groups: [{ crewName: 'Field Crew One', jobs: [{ jobNumber: 1046, address: null, status: null, customerName: null, otherCrew: [] }] }],
      unassigned: [],
      jobCount: 1,
      errors: ['property lookup: boom'],
    });
    await GET(req());
    expect(notifyTelegramAudience.mock.calls[0]![1]).toMatch(/may be incomplete/i);
  });

  it('reports DISTINCT jobs, so a two-crew job is not counted twice', async () => {
    getCrewDay.mockResolvedValue({
      date: '2026-08-29',
      groups: [
        { crewName: 'A', jobs: [{ jobNumber: 1046, address: 'x', status: null, customerName: null, otherCrew: [] }] },
        { crewName: 'B', jobs: [{ jobNumber: 1046, address: 'x', status: null, customerName: null, otherCrew: [] }] },
      ],
      unassigned: [],
      jobCount: 1,
      errors: [],
    });
    expect((await (await GET(req())).json()).jobCount).toBe(1);
  });
});
