// src/app/api/inventory/jobs/[id]/route.ts
// PATCH → move a job's fulfillment stage (the only column #82 writes).
// GET   → the job's WORK ORDER: the job + its projected materials list (the
//         design's materials joined to catalog names + on-hand stock), reusing
//         the Slice 2a/2d projection. Service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { getJob } from '@/lib/jobs';
import { setJobFulfillmentStage } from '@/lib/inventory/jobs';
import { asFulfillmentStage, fulfillmentStageOf } from '@/lib/inventory/fulfillmentStage';
import { getInventoryBindings } from '@/lib/inventory/bindings';
import { listCatalog } from '@/lib/inventory/catalog';
import { listOnHand } from '@/lib/inventory/onHand';
import { projectMaterials, buildMaterialsView } from '@/lib/inventory/materialsProjection';
import type { Scene } from '@/lib/design/sceneTypes';

export const runtime = 'nodejs';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Materials from the job's linked design (by quote_id), mirroring the 2d view.
  let scene: Scene = { yardsticks: [], items: [] };
  const sb = getSupabaseServiceClient();
  if (sb && job.quote_id) {
    const { data: design } = await sb
      .from('designs')
      .select('scene')
      .eq('quote_id', job.quote_id)
      .maybeSingle();
    if (design?.scene) scene = design.scene as Scene;
  }

  const { bindings } = await getInventoryBindings();
  const lines = projectMaterials(scene, bindings);
  const [catalog, onHand] = await Promise.all([listCatalog(), listOnHand()]);
  const nameOf = new Map(catalog.map((c) => [c.sku, c.name]));
  const onHandOf = new Map(onHand.map((r) => [r.sku, r.on_hand_qty]));
  const materials = buildMaterialsView(
    lines,
    (sku) => nameOf.get(sku),
    (sku) => (onHandOf.has(sku) ? (onHandOf.get(sku) as number) : null),
  );

  return NextResponse.json({
    job: {
      id: job.id,
      jobNumber: job.job_number,
      quoteId: job.quote_id,
      designId: job.design_id,
      stage: fulfillmentStageOf(job.fulfillment_stage),
      status: job.status,
      installDate: job.install_date,
    },
    materials,
  });
}
