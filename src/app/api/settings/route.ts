// Global app settings API (task #32). GET returns the merged settings; PUT
// upserts the provided keys (colors / render / defaults). Service-role only —
// these are app-wide business settings, not per-user.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getAppSettings,
  putAppSettings,
  normalizeColors,
  sanitizeRender,
  sanitizePortal,
  sanitizeSwatches,
  sanitizePermanentRates,
  sanitizePermanentWarranty,
  isPlainObject,
} from '@/lib/appSettings';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    const settings = await getAppSettings();
    return NextResponse.json(settings);
  } catch (err) {
    console.error('[api/settings] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }
  const { colors, defaults, render, portal, swatches, eventRates, permanentRates, permanentWarranty, permanentSwatches } =
    body as Record<string, unknown>;
  if (
    colors === undefined &&
    defaults === undefined &&
    render === undefined &&
    portal === undefined &&
    swatches === undefined &&
    eventRates === undefined &&
    permanentRates === undefined &&
    permanentWarranty === undefined &&
    permanentSwatches === undefined
  ) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  // Audit fix (#85): validate every provided key at the boundary and 400 on bad
  // input. putAppSettings silently skips a key that fails normalization and still
  // returns 200, so a malformed payload would look saved while keeping old values.
  if (colors !== undefined && normalizeColors(colors) === null) {
    return NextResponse.json(
      { error: 'colors must be a non-empty array of {id,label,hex,glow} with #rrggbb hex' },
      { status: 400 },
    );
  }
  if (defaults !== undefined && !isPlainObject(defaults)) {
    return NextResponse.json({ error: 'defaults must be an object' }, { status: 400 });
  }
  if (render !== undefined && Object.keys(sanitizeRender(render)).length === 0) {
    return NextResponse.json({ error: 'no recognized render fields' }, { status: 400 });
  }
  if (portal !== undefined && Object.keys(sanitizePortal(portal)).length === 0) {
    return NextResponse.json({ error: 'no recognized portal fields' }, { status: 400 });
  }
  // Swatches (#101): validate against the live palette so bad ids/labels are a
  // clean 400 rather than a silently-dropped key that returns 200 with old values.
  if (swatches !== undefined) {
    const validColorIds = new Set((await getAppSettings()).colors.map((c) => c.id));
    if (Object.keys(sanitizeSwatches(swatches, validColorIds)).length === 0) {
      return NextResponse.json(
        { error: 'swatches must have a valid schemes array and/or buildableColorIds array' },
        { status: 400 },
      );
    }
  }
  // Permanent swatches (#88 P6b-4): same validation as holiday swatches.
  if (permanentSwatches !== undefined) {
    const validColorIds = new Set((await getAppSettings()).colors.map((c) => c.id));
    if (Object.keys(sanitizeSwatches(permanentSwatches, validColorIds)).length === 0) {
      return NextResponse.json(
        { error: 'permanentSwatches must have a valid schemes array and/or buildableColorIds array' },
        { status: 400 },
      );
    }
  }
  // Event rates (adjustable event pricing): must be an object; putAppSettings
  // sanitizes each field (invalid → default) so it always stores a valid table.
  if (eventRates !== undefined && !isPlainObject(eventRates)) {
    return NextResponse.json({ error: 'eventRates must be an object' }, { status: 400 });
  }
  if (permanentRates !== undefined && Object.keys(sanitizePermanentRates(permanentRates)).length === 0) {
    return NextResponse.json(
      { error: 'permanentRates must have at least one valid numeric field (>= 0)' },
      { status: 400 },
    );
  }
  // Warranty copy (#88 P6b-2): must yield at least one recognized field
  // (eyebrow/heading/bullets) — a `version`-only patch is not an edit (the version
  // is server-managed), so it's rejected as "nothing recognized" rather than
  // silently returning 200 with the old copy.
  if (permanentWarranty !== undefined) {
    const s = sanitizePermanentWarranty(permanentWarranty);
    if (s.eyebrow === undefined && s.heading === undefined && s.bullets === undefined) {
      return NextResponse.json(
        { error: 'permanentWarranty must have an eyebrow, heading, and/or bullets array' },
        { status: 400 },
      );
    }
    // Foot-gun guard (P6b-2 review GAP 5): a provided heading can't be blanked and
    // a provided bullets array can't be ALL-blank — either would ship a heading-less
    // / bullet-less protection card to a booked customer. (Individual blank bullet
    // slots are still allowed — they just hide that one bullet.)
    if (s.heading !== undefined && s.heading === '') {
      return NextResponse.json(
        { error: 'permanentWarranty heading cannot be blank' },
        { status: 400 },
      );
    }
    if (s.bullets !== undefined && s.bullets.every((b) => b === '')) {
      return NextResponse.json(
        { error: 'permanentWarranty needs at least one non-blank bullet' },
        { status: 400 },
      );
    }
  }
  try {
    const settings = await putAppSettings({
      colors: colors as never,
      defaults: defaults as never,
      render: render as never,
      portal: portal as never,
      swatches: swatches as never,
      eventRates: eventRates as never,
      permanentRates: permanentRates as never,
      permanentWarranty: permanentWarranty as never,
      permanentSwatches: permanentSwatches as never,
    });
    return NextResponse.json(settings);
  } catch (err) {
    console.error('[api/settings] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
