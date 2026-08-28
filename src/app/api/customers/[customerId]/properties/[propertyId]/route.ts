// Property nickname edit + archive/unarchive (#205) — the customer-profile
// Properties tab's click-to-edit label and "Remove" (= archive, never a
// hard delete — quotes/jobs/invoices reference properties by id) controls.
// Mirrors tags/route.ts's shape.
//
// POST /api/customers/[customerId]/properties/[propertyId]   (operator-only)
// Body: { nickname?: string | null, archived?: boolean }   — at least one
//   required; each, when present, validated. Partial update: only the
//   provided key(s) are written (both may be sent together; applied as two
//   sequential single-field writes, same simplicity tradeoff tags/route.ts
//   makes for its own two independently-toggleable fields — the UI here
//   never actually sends both in one call, so this stays untested-but-inert
//   complexity rather than a real perf concern).
// Response: { ok: true, property } | { error, code? }
//
// POST (not PATCH) to match every OTHER route in this customers/[customerId]
// folder (tags, tenure-years, rebook are all POST-only) — the closer, more
// numerous sibling convention wins over the one PATCH example elsewhere in
// the codebase (designs/[id]/photos/[photoId], a different route family).
//
// Guard: propertyId must belong to customerId — every write below scopes
// its query by BOTH ids in the SAME call (updateProperty/archiveProperty/
// unarchiveProperty all take customerId + propertyId — see their comments
// in src/lib/customers.ts), so a propertyId from a DIFFERENT customer
// simply matches zero rows -> 404, never edited.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { updateProperty, archiveProperty, unarchiveProperty, type PropertyRow } from '@/lib/customers';
import { propertyArchiveBlock } from '@/lib/scheduling';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toJson(row: PropertyRow) {
  return {
    id: row.id,
    address: row.address,
    nickname: row.nickname ?? null,
    archivedAt: row.archived_at ?? null,
    // The geocode fix-list needs these to tell a correction that VERIFIED apart
    // from one that saved but is still refused — a save that "worked" while the
    // job stays unschedulable must not look fixed.
    lat: row.lat ?? null,
    lng: row.lng ?? null,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string; propertyId: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { customerId, propertyId } = await params;
  if (!UUID_RE.test(customerId) || !UUID_RE.test(propertyId)) {
    return NextResponse.json({ error: 'Invalid customer or property id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { nickname, archived, address } = (body as { nickname?: unknown; archived?: unknown; address?: unknown } | null) ?? {};
  if (nickname !== undefined && nickname !== null && typeof nickname !== 'string') {
    return NextResponse.json(
      { error: 'nickname must be a string or null if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (archived !== undefined && typeof archived !== 'boolean') {
    return NextResponse.json(
      { error: 'archived must be a boolean if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (address !== undefined && (typeof address !== 'string' || !address.trim())) {
    return NextResponse.json(
      { error: 'address must be a non-empty string if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (nickname === undefined && archived === undefined && address === undefined) {
    return NextResponse.json(
      { error: 'At least one of nickname/archived/address must be provided', code: 'invalid-body' },
      { status: 400 },
    );
  }

  let row: PropertyRow | null = null;

  if (address !== undefined) {
    // The geocode fix-list's save path: correct the address, re-geocode through
    // the anchor gate. The response includes lat/lng, so the caller can tell a
    // fix that VERIFIED apart from one that is still refused.
    const { data, error } = await updateProperty(customerId, propertyId, { address: address as string });
    if (error) {
      // A 23505 here is the address_key collision: the corrected address already
      // exists as another property of the same customer. Surface it usefully.
      if (/duplicate key|23505/.test(error.message)) {
        return NextResponse.json(
          { error: 'This customer already has a property with that address.', code: 'duplicate-address' },
          { status: 409 },
        );
      }
      console.error('[api/customers/:customerId/properties/:propertyId] address update failed:', error);
      return NextResponse.json({ error: 'Failed to update this property' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Property not found' }, { status: 404 });
    row = data;
  }

  if (nickname !== undefined) {
    const { data, error } = await updateProperty(customerId, propertyId, { nickname });
    if (error) {
      console.error('[api/customers/:customerId/properties/:propertyId] nickname update failed:', error);
      return NextResponse.json({ error: 'Failed to update this property' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Property not found' }, { status: 404 });
    row = data;
  }

  if (archived !== undefined) {
    // Archiving a property that a JOB references would strand the job: the
    // property leaves the geocode fix-list, which is the only path to ever
    // giving it coordinates, so the job could never be scheduled and nothing
    // would say why. Refuse with a plain reason instead (2026-08-28; job
    // #1045 is the live example). The check verifies OWNERSHIP first and
    // answers a mismatched pair with the same opaque 404 as every other write
    // here — a 409 for a foreign property id would leak whether it has jobs.
    // Unarchiving needs no guard.
    if (archived) {
      const block = await propertyArchiveBlock(customerId, propertyId);
      if (block === 'not-found') {
        return NextResponse.json({ error: 'Property not found' }, { status: 404 });
      }
      if (block === 'has-jobs') {
        return NextResponse.json(
          {
            error: 'This property has a job attached. Fix its address instead of archiving it.',
            code: 'has-jobs',
          },
          { status: 409 },
        );
      }
      if (block === 'has-live-quote') {
        return NextResponse.json(
          {
            error:
              'This property has a live quote attached (sent, viewed, approved, or booked). Fix its address instead of archiving it.',
            code: 'has-live-quote',
          },
          { status: 409 },
        );
      }
    }
    const { data, error } = archived
      ? await archiveProperty(customerId, propertyId)
      : await unarchiveProperty(customerId, propertyId);
    if (error) {
      console.error('[api/customers/:customerId/properties/:propertyId] archive update failed:', error);
      return NextResponse.json({ error: 'Failed to update this property' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Property not found' }, { status: 404 });
    row = data;
  }

  return NextResponse.json({ ok: true, property: toJson(row!) });
}
