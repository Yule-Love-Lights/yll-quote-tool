// src/app/api/inventory/catalog/route.ts
// Catalog API (#82 Slice 1a). GET lists the catalog; POST imports it from a raw
// Thunder CSV string. Service-role only — mirrors src/app/api/settings/route.ts.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listCatalog, upsertCatalogItems } from '@/lib/inventory/catalog';
import { parseThunderCsv } from '@/lib/inventory/parseThunderCsv';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await listCatalog());
  } catch (err) {
    console.error('[api/inventory/catalog] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const csv = (body as Record<string, unknown>)?.csv;
  if (typeof csv !== 'string' || !csv.trim()) {
    return NextResponse.json({ error: 'Body must include a non-empty `csv` string' }, { status: 400 });
  }
  try {
    const items = parseThunderCsv(csv);
    const imported = await upsertCatalogItems(items);
    return NextResponse.json({ parsed: items.length, imported });
  } catch (err) {
    console.error('[api/inventory/catalog] POST failed:', err);
    return NextResponse.json({ error: 'Failed to import catalog' }, { status: 500 });
  }
}
