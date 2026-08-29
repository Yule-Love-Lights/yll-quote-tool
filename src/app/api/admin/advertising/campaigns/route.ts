import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import {
  CampaignRateConflictError,
  createAdvertisingCampaign,
  listAdvertisingCampaigns,
  updateAdvertisingCampaign,
} from '@/lib/advertising/campaigns';

export const runtime = 'nodejs';

/**
 * Campaign management (ops hub workstream B). The rate here is MONEY CONFIG:
 * rate_cents is what every future acceptance stamps. The data layer logs a
 * rate_changed audit row with the acting admin, and refuses a rate edit that
 * lost a concurrent-edit race (so the audit trail never lies).
 *
 *   GET   /api/admin/advertising/campaigns — all campaigns, active first
 *   POST  /api/admin/advertising/campaigns — create (defaults 250 cents)
 *   PATCH /api/admin/advertising/campaigns — edit name/notes/rate/active
 */

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const campaigns = await listAdvertisingCampaigns({ includeInactive: true });
  return NextResponse.json({ campaigns });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; notes?: unknown; rateCents?: unknown; isTest?: unknown }
    | null;
  const name = String(body?.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'Give the campaign a name.' }, { status: 400 });

  try {
    const campaign = await createAdvertisingCampaign({
      name,
      notes: typeof body?.notes === 'string' ? body.notes : null,
      rateCents: typeof body?.rateCents === 'number' ? body.rateCents : undefined,
      isTest: body?.isTest === true,
    });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to create the campaign';
    const badRate = /rate/i.test(message);
    console.error('POST /api/admin/advertising/campaigns:', message);
    return NextResponse.json(
      { error: badRate ? 'The rate must be a whole number of cents, 0 or more.' : 'Failed to create the campaign' },
      { status: badRate ? 400 : 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { campaignId?: unknown; name?: unknown; notes?: unknown; rateCents?: unknown; active?: unknown }
    | null;
  const campaignId = String(body?.campaignId ?? '').trim();
  if (!campaignId) return NextResponse.json({ error: 'Choose a campaign.' }, { status: 400 });

  const patch: { name?: string; notes?: string | null; rateCents?: number; active?: boolean } = {};
  if (typeof body?.name === 'string') patch.name = body.name;
  if (typeof body?.notes === 'string' || body?.notes === null) patch.notes = body?.notes as string | null;
  if (typeof body?.rateCents === 'number') patch.rateCents = body.rateCents;
  if (typeof body?.active === 'boolean') patch.active = body.active;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  try {
    // Actor = the admin session; the data layer stamps it on the
    // rate_changed audit row.
    const campaign = await updateAdvertisingCampaign(campaignId, patch, auth.operator.id);
    if (!campaign) return NextResponse.json({ error: 'That campaign does not exist.' }, { status: 404 });
    return NextResponse.json({ campaign });
  } catch (e) {
    if (e instanceof CampaignRateConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : 'Failed to update the campaign';
    const badRate = /rate/i.test(message) && !/conflict/i.test(message);
    console.error('PATCH /api/admin/advertising/campaigns:', message);
    return NextResponse.json(
      { error: badRate ? 'The rate must be a whole number of cents, 0 or more.' : 'Failed to update the campaign' },
      { status: badRate ? 400 : 500 },
    );
  }
}
