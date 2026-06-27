// src/app/api/inventory/materials/route.ts
// Materials list for a quote's design (#82 Slice 2d). Projects the design's
// per-unit materials (Slice 2a) and joins catalog names + on-hand stock. Service-
// role only — mirrors the other /api/inventory routes. Per-unit only for now;
// roofline bulbs/wire/clips are Slice 2b.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { getInventoryBindings } from '@/lib/inventory/bindings';
import { listCatalog } from '@/lib/inventory/catalog';
import { listOnHand } from '@/lib/inventory/onHand';
import { projectMaterials, aggregateMaterials } from '@/lib/inventory/materialsProjection';
import type { Scene } from '@/lib/design/sceneTypes';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
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
    // sharp-importing designs.ts and the photo signing we don't need here).
    const { data: design } = await sb
      .from('designs')
      .select('scene')
      .eq('quote_id', quoteId.trim())
      .maybeSingle();
    const scene = (design?.scene ?? { yardsticks: [], items: [] }) as Scene;

    const { bindings } = await getInventoryBindings();
    const lines = projectMaterials(scene, bindings);
    const aggregated = aggregateMaterials(lines);

    const [catalog, onHand] = await Promise.all([listCatalog(), listOnHand()]);
    const nameOf = new Map(catalog.map((c) => [c.sku, c.name]));
    const onHandOf = new Map(onHand.map((r) => [r.sku, r.on_hand_qty]));

    const materials = aggregated.map((a) => {
      const oh = onHandOf.has(a.sku) ? (onHandOf.get(a.sku) as number) : null;
      return {
        sku: a.sku,
        name: nameOf.get(a.sku) ?? '(not in catalog)',
        qty: a.qty,
        onHand: oh,
        short: oh !== null && oh < a.qty,
      };
    });

    // Unbound concepts: group the null-sku lines by conceptKey (summed qty).
    const unboundMap = new Map<string, { conceptKey: string; label: string; qty: number }>();
    for (const l of lines) {
      if (l.sku) continue;
      const cur = unboundMap.get(l.conceptKey);
      if (cur) cur.qty += l.qty;
      else unboundMap.set(l.conceptKey, { conceptKey: l.conceptKey, label: l.label, qty: l.qty });
    }
    const unbound = [...unboundMap.values()].sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({ hasDesign: !!design, materials, unbound, totalLines: lines.length });
  } catch (err) {
    console.error('[api/inventory/materials] GET failed:', err);
    return NextResponse.json({ error: 'Failed to project materials' }, { status: 500 });
  }
}
