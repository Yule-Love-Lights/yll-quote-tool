import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import {
  CampaignHasPhotosError,
  CampaignRateConflictError,
  createAdvertisingCampaign,
  deleteAdvertisingCampaign,
  listAdvertisingCampaigns,
  updateAdvertisingCampaign,
} from '@/lib/advertising/campaigns';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

export const runtime = 'nodejs';

/**
 * Campaign management (ops hub workstream B). The rate here is MONEY CONFIG:
 * rate_cents is what every future acceptance stamps. The data layer logs a
 * rate_changed audit row with the acting admin, and refuses a rate edit that
 * lost a concurrent-edit race (so the audit trail never lies).
 *
 *   GET   /api/admin/advertising/campaigns — all campaigns, active first
 *   POST  /api/admin/advertising/campaigns — create (defaults 250 cents)
 *   PATCH /api/admin/advertising/campaigns — edit name/notes/type/rate/active
 *   DELETE /api/admin/advertising/campaigns — remove a campaign nothing points at
 */

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const campaigns = await listAdvertisingCampaigns({ includeInactive: true });
  const { campaignActivitySummary } = await import('@/lib/advertising/placements');
  const activity = await campaignActivitySummary(campaigns.map((c) => c.id));
  return NextResponse.json({
    campaigns: campaigns.map((c) => {
      const a = activity.get(c.id);
      return {
        ...c,
        photoCount: a?.photoCount ?? 0,
        workerCount: a?.workerCount ?? 0,
        lastPhotoAt: a?.lastPhotoAt ?? null,
        pendingCount: a?.pendingCount ?? 0,
      };
    }),
  });
}

/**
 * Read rateCents STRICTLY. A rate that is present but malformed (a string
 * like "$5.00" or "250", a float, a negative) is a hard refusal — the old
 * typeof check silently DROPPED it, which created the campaign at the $2.50
 * default under a success message (the staff lens HIGH on this PR: every
 * acceptance after that stamps the wrong money).
 */
function readRateCents(
  body: Record<string, unknown> | null,
): { ok: true; value: number | undefined } | { ok: false } {
  if (!body || !('rateCents' in body)) return { ok: true, value: undefined };
  const v = body.rateCents;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return { ok: true, value: v };
  return { ok: false };
}

const BAD_RATE = 'The rate must be sent as a whole number of cents, 0 or more.';

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; kind?: unknown; notes?: unknown; rateCents?: unknown; isTest?: unknown }
    | null;
  const name = String(body?.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'Give the campaign a name.' }, { status: 400 });

  const rate = readRateCents(body as Record<string, unknown> | null);
  if (!rate.ok) return NextResponse.json({ error: BAD_RATE }, { status: 400 });

  try {
    const kind = body?.kind === 'door_hanger' ? 'door_hanger' as const : 'yard_sign' as const;
    const campaign = await createAdvertisingCampaign({
      name,
      kind,
      notes: typeof body?.notes === 'string' ? body.notes : null,
      rateCents: rate.value,
      isTest: body?.isTest === true,
    });
    await logAdvertisingActivity({
      actor: auth.operator.id,
      action: 'campaign_created',
      detail: { campaignId: campaign.id, name: campaign.name, rateCents: campaign.rateCents },
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
    | { campaignId?: unknown; name?: unknown; notes?: unknown; rateCents?: unknown; active?: unknown; kind?: unknown }
    | null;
  const campaignId = String(body?.campaignId ?? '').trim();
  if (!campaignId) return NextResponse.json({ error: 'Choose a campaign.' }, { status: 400 });

  const rate = readRateCents(body as Record<string, unknown> | null);
  if (!rate.ok) return NextResponse.json({ error: BAD_RATE }, { status: 400 });

  // A name that is present but blank (or not a string at all) is a user
  // error, and it reads as one. Without this the data layer's throw lands in
  // the catch below as a generic 500, which tells the admin nothing about
  // what to fix; and a non-string name was silently DROPPED, the same shape
  // as the rate bug this file's tests pin.
  if (body?.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Give the campaign a name.' }, { status: 400 });
    }
  }
  // Every other patch field is refused when malformed rather than dropped,
  // for the same reason the rate is: sent alongside a valid field the patch
  // is not empty, so a dropped one returns a cheerful 200 having ignored
  // half of what the admin asked for.
  if (body?.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    return NextResponse.json({ error: 'The description must be text.' }, { status: 400 });
  }
  if (body?.active !== undefined && typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'Send the campaign as open or closed, true or false.' }, { status: 400 });
  }
  if (body?.kind !== undefined && body.kind !== 'yard_sign' && body.kind !== 'door_hanger') {
    return NextResponse.json(
      { error: 'A campaign is either yard signs or door hangers.' },
      { status: 400 },
    );
  }

  const patch: {
    name?: string;
    notes?: string | null;
    rateCents?: number;
    active?: boolean;
    kind?: 'yard_sign' | 'door_hanger';
  } = {};
  if (typeof body?.name === 'string') patch.name = body.name;
  if (typeof body?.notes === 'string' || body?.notes === null) patch.notes = body?.notes as string | null;
  if (rate.value !== undefined) patch.rateCents = rate.value;
  if (typeof body?.active === 'boolean') patch.active = body.active;
  if (body?.kind === 'yard_sign' || body?.kind === 'door_hanger') patch.kind = body.kind;
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

/**
 * DELETE — remove a campaign that nothing points at.
 *
 * A campaign holding photos is somebody's paid work, so this refuses with a
 * 409 and the count rather than cascading. Closing is the answer there: it
 * keeps every photo and every payment and can be undone.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = String(body?.campaignId ?? '').trim();
  if (!campaignId) return NextResponse.json({ error: 'Choose a campaign.' }, { status: 400 });

  try {
    await deleteAdvertisingCampaign(campaignId, auth.operator.id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    if (e instanceof CampaignHasPhotosError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : 'Failed to delete the campaign';
    if (/no campaign found/i.test(message)) {
      return NextResponse.json({ error: 'That campaign does not exist.' }, { status: 404 });
    }
    console.error('DELETE /api/admin/advertising/campaigns:', message);
    return NextResponse.json({ error: 'Failed to delete the campaign' }, { status: 500 });
  }
}
