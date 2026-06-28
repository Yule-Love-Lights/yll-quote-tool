// src/app/api/inventory/jobs/route.ts
// Fulfillment board feed (#82 Slice 3). GET → the active-fulfillment jobs as
// board cards (newest first, customer identity joined). Service-role only —
// mirrors the other /api/inventory routes. Stage moves + the per-job work order
// live in ./[id]/route.ts.

import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listFulfillmentCards } from '@/lib/inventory/jobs';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ cards: await listFulfillmentCards() });
  } catch (err) {
    console.error('[api/inventory/jobs] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 });
  }
}
