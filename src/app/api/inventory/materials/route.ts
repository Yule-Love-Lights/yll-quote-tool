// src/app/api/inventory/materials/route.ts
// Materials list for a quote's design (#82 Slice 2d). Projects the design's
// per-unit materials (Slice 2a) + roofline C9 bulbs/clips (Slice 2b) and joins
// catalog names + on-hand stock. Service-role only — mirrors the other
// /api/inventory routes. (Socket wire is a deferred follow-up — no binding yet.)

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInventoryBindings } from '@/lib/inventory/bindings';
import { listCatalog } from '@/lib/inventory/catalog';
import { listOnHand } from '@/lib/inventory/onHand';
import { projectMaterials, buildMaterialsView } from '@/lib/inventory/materialsProjection';
import { colorChoiceFromSnapshot } from '@/lib/inventory/resolveInstalls';
import type { Scene } from '@/lib/design/sceneTypes';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const quoteId = req.nextUrl.searchParams.get('quote');
  if (!quoteId || !quoteId.trim()) {
    return NextResponse.json({ error: 'Missing `quote` query param' }, { status: 400 });
  }
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    // The design linked to this quote (at most one; direct query avoids the
    // sharp-importing designs.ts and the photo signing we don't need here) + the
    // quote's approved color choice (#92). Pre-approval → no snapshot → as-designed.
    const [{ data: design }, { data: quote }] = await Promise.all([
      sb.from('designs').select('scene').eq('quote_id', quoteId.trim()).maybeSingle(),
      sb.from('quotes').select('approval_snapshot').eq('id', quoteId.trim()).maybeSingle(),
    ]);
    const scene = (design?.scene ?? { yardsticks: [], items: [] }) as Scene;
    const colorChoice = colorChoiceFromSnapshot((quote as { approval_snapshot: unknown } | null)?.approval_snapshot ?? null);

    const { bindings, clipRules } = await getInventoryBindings();
    const lines = projectMaterials(scene, bindings, clipRules, colorChoice);

    const [catalog, onHand] = await Promise.all([listCatalog(), listOnHand()]);
    const nameOf = new Map(catalog.map((c) => [c.sku, c.name]));
    const onHandOf = new Map(onHand.map((r) => [r.sku, r.on_hand_qty]));

    const view = buildMaterialsView(
      lines,
      (sku) => nameOf.get(sku),
      (sku) => (onHandOf.has(sku) ? (onHandOf.get(sku) as number) : null),
    );
    return NextResponse.json({ hasDesign: !!design, ...view });
  } catch (err) {
    console.error('[api/inventory/materials] GET failed:', err);
    return NextResponse.json({ error: 'Failed to project materials' }, { status: 500 });
  }
}
