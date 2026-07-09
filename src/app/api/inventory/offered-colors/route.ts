// src/app/api/inventory/offered-colors/route.ts
// #92 — the offered solid colors per item type (mini / spritzer-by-size), derived
// from the live inventory bindings. The builder + "From your design" fetch this to
// flag items in colors we can't supply (detectUnfulfillable). Service-role read.
//
// DELIBERATELY PUBLIC (S26): the customer portal's color picker (DesignCanvas →
// buildRenderColorMap) fetches this anonymously — customers have no operator
// session. Data is non-sensitive (just which color ids we stock; no prices,
// customers, or inventory counts). Auth (requireOperator) was removed here after
// it 401'd every anonymous portal customer once AUTH_GATE_ENABLED went live,
// silently killing the color picker (item toggles kept working since they have
// no fetch dependency). Keep this route auth-free.

import { NextResponse } from 'next/server';
import { getInventoryBindings } from '@/lib/inventory/bindings';
import { offeredColorLists } from '@/lib/inventory/resolveInstalls';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const { bindings } = await getInventoryBindings();
    return NextResponse.json(offeredColorLists(bindings));
  } catch (err) {
    console.error('[api/inventory/offered-colors] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read offered colors' }, { status: 500 });
  }
}
