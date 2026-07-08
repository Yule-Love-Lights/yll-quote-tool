// src/app/api/inventory/categories/route.ts
// Category show/hide list (#82 Slice 1b-iii). GET returns the hidden-category
// names; PUT replaces them. Stored in app_settings under `hiddenCategories`.
// Service-role only — mirrors src/app/api/inventory/bindings/route.ts.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getHiddenCategories, setHiddenCategories, normalizeHiddenCategories } from '@/lib/inventory/catalog';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ hiddenCategories: await getHiddenCategories() });
  } catch (err) {
    console.error('[api/inventory/categories] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load categories' }, { status: 500 });
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
  const hidden = (body as Record<string, unknown>)?.hiddenCategories;
  if (!Array.isArray(hidden)) {
    return NextResponse.json({ error: '`hiddenCategories` must be an array' }, { status: 400 });
  }
  try {
    const saved = await setHiddenCategories(normalizeHiddenCategories(hidden));
    return NextResponse.json({ hiddenCategories: saved });
  } catch (err) {
    console.error('[api/inventory/categories] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save categories' }, { status: 500 });
  }
}
