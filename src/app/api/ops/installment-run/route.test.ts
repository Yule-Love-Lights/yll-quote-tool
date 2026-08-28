import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireOperator, runInstallments, notifyTelegramAudience } = vi.hoisted(() => ({
  requireOperator: vi.fn<() => Promise<unknown>>(),
  runInstallments: vi.fn<(opts: { dryRun: boolean }) => Promise<unknown>>(),
  notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator }));
vi.mock('@/lib/integrations/telegramRouting', () => ({ notifyTelegramAudience }));
// The runner itself is exercised by installmentRunner.test.ts; here only the
// gating matters, so the IO seam is mocked and the two flag helpers stay real.
vi.mock('@/lib/installmentRunner', async () => {
  const actual = await vi.importActual<typeof import('@/lib/installmentRunner')>('@/lib/installmentRunner');
  return { ...actual, runInstallments };
});

import { GET, POST } from './route';

const SECRET = 'cron-secret';

function req(opts: { secret?: string; body?: unknown } = {}): NextRequest {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'authorization' && opts.secret ? `Bearer ${opts.secret}` : null),
    },
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
  } as unknown as NextRequest;
}

const emptyRun = (dryRun: boolean) => ({ ok: true, dryRun, today: '2026-09-06', decisions: [], outcomes: [] });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  delete process.env.INSTALLMENT_RUNNER_ENABLED;
  requireOperator.mockResolvedValue(null); // signed-in operator
  runInstallments.mockImplementation(async ({ dryRun }) => emptyRun(dryRun));
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.INSTALLMENT_RUNNER_ENABLED;
});

describe('auth', () => {
  it('401s a request whose Bearer token is wrong, without touching the runner', async () => {
    const res = await GET(req({ secret: 'nope' }));
    expect(res.status).toBe(401);
    expect(runInstallments).not.toHaveBeenCalled();
  });

  it('503s and names the variable when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ secret: 'anything' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('CRON_SECRET');
    expect(runInstallments).not.toHaveBeenCalled();
  });

  it('falls to requireOperator when there is no Authorization header, and refuses an anonymous caller', async () => {
    requireOperator.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(req({ body: { dryRun: false } }));
    expect(res.status).toBe(401);
    expect(runInstallments).not.toHaveBeenCalled();
  });
});

describe('the dry-run gates', () => {
  it('POST is a dry run by default', async () => {
    await POST(req({ body: {} }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: true });
  });

  it('POST with no body at all is still a dry run', async () => {
    await POST(req({ secret: undefined }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: true });
  });

  it('POST dryRun:false is STILL dry while INSTALLMENT_RUNNER_ENABLED is off', async () => {
    const res = await POST(req({ body: { dryRun: false } }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: true });
    const body = await res.json();
    expect(body.runnerArmed).toBe(false);
    expect(body.dryRun).toBe(true);
  });

  it('POST dryRun:false goes live only once the flag is armed', async () => {
    process.env.INSTALLMENT_RUNNER_ENABLED = 'true';
    await POST(req({ body: { dryRun: false } }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: false });
  });

  it('the cron leg is dry while the flag is off', async () => {
    await GET(req({ secret: SECRET }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: true });
  });

  it('the cron leg goes live once the flag is armed', async () => {
    process.env.INSTALLMENT_RUNNER_ENABLED = 'true';
    await GET(req({ secret: SECRET }));
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: false });
  });

  // Premerge technical lens HIGH: an earlier draft had GET request a live run
  // unconditionally, so with the flags on, an operator who merely opened this
  // URL in a browser charged real cards. A valid CRON_SECRET means "charge"; a
  // valid operator session does not.
  it('an OPERATOR GET is a dry run even with the flag armed', async () => {
    process.env.INSTALLMENT_RUNNER_ENABLED = 'true';
    const res = await GET(req()); // no Authorization header -> requireOperator
    expect(requireOperator).toHaveBeenCalled();
    expect(runInstallments).toHaveBeenCalledWith({ dryRun: true });
    expect((await res.json()).runnerArmed).toBe(true);
  });
});

describe('reporting', () => {
  it('503s when the run itself could not load', async () => {
    runInstallments.mockResolvedValue({ ok: false, error: 'Supabase service role not configured' });
    const res = await GET(req({ secret: SECRET }));
    expect(res.status).toBe(503);
  });

  it('sends no staff alert on a quiet live run', async () => {
    process.env.INSTALLMENT_RUNNER_ENABLED = 'true';
    await GET(req({ secret: SECRET }));
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('alerts staff when a live run actually charged something', async () => {
    process.env.INSTALLMENT_RUNNER_ENABLED = 'true';
    runInstallments.mockResolvedValue({
      ok: true,
      dryRun: false,
      today: '2026-09-06',
      decisions: [],
      outcomes: [
        {
          quoteId: 'q-1', quoteNumber: 1315, customerName: 'Jane Laguerre', installmentId: 'i-4',
          seq: 4, amountUsd: 453.13, status: 'charged', txnId: 'TXN-1', message: null,
        },
      ],
    });
    await GET(req({ secret: SECRET }));
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    expect(notifyTelegramAudience.mock.calls[0]![1]).toContain('Jane Laguerre');
  });

  it('never alerts staff from a DRY run, however loud its summary', async () => {
    runInstallments.mockResolvedValue({
      ok: true,
      dryRun: true,
      today: '2026-09-06',
      decisions: [],
      outcomes: [
        {
          quoteId: 'q-1', quoteNumber: 1315, customerName: 'Jane Laguerre', installmentId: 'i-4',
          seq: 4, amountUsd: 453.13, status: 'charged', txnId: 'TXN-1', message: null,
        },
      ],
    });
    await POST(req({ body: {} }));
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });
});
