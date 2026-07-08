// src/app/api/inventory/offered-colors/route.ts
// #92 — the offered solid colors per item type (mini / spritzer-by-size), derived
// from the live inventory bindings. The builder + "From your design" fetch this to
// flag items in colors we can't supply (detectUnfulfillable). Service-role read,
// mirroring /api/inventory/materials. Non-sensitive (just which colors we stock).

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInventoryBindings } from '@/lib/inventory/bindings';
import { offeredColorLists } from '@/lib/inventory/resolveInstalls';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  try {
    const { bindings } = await getInventoryBindings();
    return NextResponse.json(offeredColorLists(bindings));
  } catch (err) {
    console.error('[api/inventory/offered-colors] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read offered colors' }, { status: 500 });
  }
}
