import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { ensureWorkerForAuthUser } from '@/lib/advertising/workers';
import { handleCaptureSubmit } from '@/lib/advertising/captureSubmit';

export const runtime = 'nodejs';

/**
 * POST /api/admin/advertising/capture — the ADMIN camera (Simple Crew
 * replica: owners shoot too). Submits through the exact same pipeline as a
 * worker, under an advertising_workers row auto-provisioned for the admin's
 * own login on first use (linked by auth_user_id, so it is theirs forever
 * after). Their signs then flow through the same review + pay rules as
 * anyone's — an owner's accepted yard sign is still a placed sign.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  try {
    const worker = await ensureWorkerForAuthUser(
      auth.operator.id,
      auth.operator.name ?? auth.operator.email?.split('@')[0] ?? 'Admin',
    );
    return await handleCaptureSubmit(req, worker);
  } catch (e) {
    console.error('POST /api/admin/advertising/capture:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not submit. Try again.' }, { status: 500 });
  }
}
