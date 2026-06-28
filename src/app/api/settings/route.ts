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
  const { colors, defaults, render, portal } = body as Record<string, unknown>;
  if (colors === undefined && defaults === undefined && render === undefined && portal === undefined) {
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
  try {
    const settings = await putAppSettings({
      colors: colors as never,
      defaults: defaults as never,
      render: render as never,
      portal: portal as never,
    });
    return NextResponse.json(settings);
  } catch (err) {
    console.error('[api/settings] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
