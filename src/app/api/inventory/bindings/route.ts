// src/app/api/inventory/bindings/route.ts
// Inventory bindings API (#82 Slice 1b). GET returns current bindings+clipRules;
// PUT validates then saves the provided keys. Service-role only — mirrors
// src/app/api/settings/route.ts. Validates BEFORE write (rejects malformed 400).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getInventoryBindings,
  putInventoryBindings,
  normalizeBindings,
  normalizeClipRules,
} from '@/lib/inventory/bindings';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await getInventoryBindings());
  } catch (err) {
    console.error('[api/inventory/bindings] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load bindings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
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
  const { bindings, clipRules } = body as Record<string, unknown>;
  if (bindings === undefined && clipRules === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  if (bindings !== undefined && normalizeBindings(bindings) === null) {
    return NextResponse.json({ error: 'Invalid bindings' }, { status: 400 });
  }
  if (clipRules !== undefined && normalizeClipRules(clipRules) === null) {
    return NextResponse.json({ error: 'Invalid clipRules' }, { status: 400 });
  }
  try {
    const result = await putInventoryBindings({
      bindings: bindings as never,
      clipRules: clipRules as never,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/inventory/bindings] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save bindings' }, { status: 500 });
  }
}
