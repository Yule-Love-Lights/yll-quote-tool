import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getAdvertisingWorker } from '@/lib/advertising/workers';
import { handleBulkAcceptedSubmit } from '@/lib/advertising/captureSubmit';

export const runtime = 'nodejs';

/**
 * POST /api/admin/advertising/placements/bulk — ADMIN ONLY. One photo per
 * request, attributed to the workerId in the form and landing directly
 * ACCEPTED at the campaign's current rate (Naldo's backfill ruling,
 * 2026-08-29: work done before the tool existed still counts and pays).
 * The heavy lifting and every money guard live in handleBulkAcceptedSubmit
 * and submitAcceptedPlacement; this route only authenticates and resolves
 * the target worker.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Send the upload as multipart form data.' }, { status: 400 });
  }

  const workerId = String(form.get('workerId') ?? '').trim();
  if (!workerId) {
    return NextResponse.json({ error: 'Pick the worker these photos belong to.' }, { status: 400 });
  }
  // Inactive workers are allowed on purpose: backfilled work predates the
  // tool, and the person may already be deactivated.
  const worker = await getAdvertisingWorker(workerId);
  if (!worker) {
    return NextResponse.json({ error: 'That worker does not exist.' }, { status: 404 });
  }

  return handleBulkAcceptedSubmit(form, worker, auth.operator.id);
}
