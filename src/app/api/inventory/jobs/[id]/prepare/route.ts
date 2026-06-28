// src/app/api/inventory/jobs/[id]/prepare/route.ts
// POST → mark a job prepped and DECREMENT its on-hand stock (#82 Phase 2,
// Naldo Q4: stock decremented only at prep). Idempotent — prepareJobMaterials
// atomically claims the job so a retry/double-click can't double-deduct.
// Service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { prepareJobMaterials } from '@/lib/inventory/jobs';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  const result = await prepareJobMaterials(id);
  if (!result) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json(result);
}
