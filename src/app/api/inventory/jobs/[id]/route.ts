// src/app/api/inventory/jobs/[id]/route.ts
// PATCH → move a job's fulfillment stage (the only column #82 writes).
// GET   → the job's WORK ORDER: the job + its projected materials list (the
//         design's materials joined to catalog names + on-hand stock), reusing
//         the Slice 2a/2d projection. Service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { setJobFulfillmentStage, getJobWorkOrder } from '@/lib/inventory/jobs';
import { asFulfillmentStage } from '@/lib/inventory/fulfillmentStage';

export const runtime = 'nodejs';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const stage = asFulfillmentStage((body as Record<string, unknown> | null)?.stage);
  if (!stage) {
    return NextResponse.json({ error: 'Body must include a valid `stage`' }, { status: 400 });
  }
  const ok = await setJobFulfillmentStage(id, stage);
  if (!ok) return NextResponse.json({ error: 'Failed to update stage' }, { status: 500 });
  return NextResponse.json({ ok: true, stage });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  const wo = await getJobWorkOrder(id);
  if (!wo) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json(wo);
}
