import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { DEFAULT_STALE_SEGMENT_HOURS, listTimeExceptions } from '@/lib/opsTimeExceptions';

export const runtime = 'nodejs';

/**
 * GET /api/ops/time-exceptions — the time-exception queue (row 278).
 *
 * ADMIN-ONLY (Naldo's ruling, 2026-08-29 — was operator-only from row 278).
 * The queue's UI lives on the admin-only /admin/time-tracking page, and the
 * API gate now agrees with the page gate: it lists other people's stuck time
 * records, which sit next to pay. Still deliberately NOT under /api/ops/v1,
 * which is the crew-confined namespace.
 *
 * READ-ONLY. It closes nothing. Manual punches are authoritative for pay, so a
 * human decides what actually happened; the midnight cron already handles the
 * one case that can be resolved without judgement.
 *
 * `?staleHours=` overrides the idle gap for the missed-tap check, so the office
 * can widen or tighten it without a deploy.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const raw = req.nextUrl.searchParams.get('staleHours');
  const parsed = raw === null ? DEFAULT_STALE_SEGMENT_HOURS : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NextResponse.json({ error: 'staleHours must be a positive number' }, { status: 400 });
  }

  const { exceptions, errors } = await listTimeExceptions(new Date(), parsed);

  if (errors.length) console.error('time-exceptions:', errors.join(' | '));

  return NextResponse.json({
    count: exceptions.length,
    staleHours: parsed,
    exceptions,
    // Surfaced rather than swallowed: a partial scan that silently returned an
    // empty list would read as "nothing is wrong", which is the opposite of true.
    errors,
  });
}
