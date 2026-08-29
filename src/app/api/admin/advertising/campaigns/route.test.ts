// Campaign money config. The staff lens found the HIGH this file pins: a
// rate that arrives as a STRING ("$5.00", "250") must be a hard 400 — the
// old typeof-number check silently DROPPED it, created the campaign at the
// $2.50 default, and reported success. A silent wrong rate is stamped onto
// every acceptance after it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireAdmin, createAdvertisingCampaign, updateAdvertisingCampaign, listAdvertisingCampaigns, logAdvertisingActivity } =
  vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    createAdvertisingCampaign: vi.fn(),
    updateAdvertisingCampaign: vi.fn(),
    listAdvertisingCampaigns: vi.fn(),
    logAdvertisingActivity: vi.fn(),
  }));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/campaigns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/campaigns')>();
  return { ...actual, createAdvertisingCampaign, updateAdvertisingCampaign, listAdvertisingCampaigns };
});
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));

import { PATCH, POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };
const CAMPAIGN = {
  id: 'campaign-1',
  name: 'Fall',
  notes: null,
  rateCents: 250,
  active: true,
  isTest: false,
  createdAt: 'x',
  updatedAt: 'x',
};

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  createAdvertisingCampaign.mockResolvedValue(CAMPAIGN);
  updateAdvertisingCampaign.mockResolvedValue({ ...CAMPAIGN, rateCents: 300 });
  listAdvertisingCampaigns.mockResolvedValue([CAMPAIGN]);
});

describe('auth', () => {
  it('non-admins are refused', async () => {
    requireAdmin.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    expect((await POST(makeReq({ name: 'Fall' }))).status).toBe(403);
    expect(createAdvertisingCampaign).not.toHaveBeenCalled();
  });
});

describe('rate input is refused when malformed, NEVER silently dropped', () => {
  it('POST 400s a string rate instead of creating at the default', async () => {
    for (const bad of ['$5.00', '250', '2.50']) {
      const res = await POST(makeReq({ name: 'Fall', rateCents: bad }));
      expect(res.status).toBe(400);
    }
    expect(createAdvertisingCampaign).not.toHaveBeenCalled();
  });

  it('POST 400s a fractional or negative rate', async () => {
    expect((await POST(makeReq({ name: 'Fall', rateCents: 250.5 }))).status).toBe(400);
    expect((await POST(makeReq({ name: 'Fall', rateCents: -1 }))).status).toBe(400);
    expect(createAdvertisingCampaign).not.toHaveBeenCalled();
  });

  it('PATCH 400s a string or malformed rate the same way', async () => {
    expect((await PATCH(makeReq({ campaignId: 'campaign-1', rateCents: '300' }))).status).toBe(400);
    expect((await PATCH(makeReq({ campaignId: 'campaign-1', rateCents: 3.005 }))).status).toBe(400);
    expect(updateAdvertisingCampaign).not.toHaveBeenCalled();
  });

  it('a valid integer-cent rate passes through unchanged', async () => {
    const res = await POST(makeReq({ name: 'Fall', rateCents: 300 }));
    expect(res.status).toBe(201);
    expect(createAdvertisingCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ rateCents: 300 }),
    );
  });

  it('omitting the rate entirely still uses the default (a deliberate omission is fine)', async () => {
    const res = await POST(makeReq({ name: 'Fall' }));
    expect(res.status).toBe(201);
    expect(createAdvertisingCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ rateCents: undefined }),
    );
  });
});

describe('audit', () => {
  it('campaign creation writes a campaign_created row with the admin as actor', async () => {
    await POST(makeReq({ name: 'Fall', rateCents: 250 }));
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'admin-1', action: 'campaign_created' }),
    );
  });
});
