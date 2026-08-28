import { NextRequest, NextResponse } from 'next/server';

import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { DEFAULT_STALE_SEGMENT_HOURS, listTimeExceptions } from '@/lib/opsTimeExceptions';

export const runtime = 'nodejs';

/**
 * GET /api/ops/time-exceptions — the time-exception queue (row 278).
 *
 * OPERATOR-ONLY. This is an office surface, not a crew one: it lists other
 * people's stuck time records, and it is the office that corrects them.
 * Deliberately NOT under /api/ops/v1, which WAS the crew-confined namespace
 * (deleted with the Operations Hub, row 433; crew logins retired, row 438).
 *
 * READ-ONLY. It closes nothing. Manual punches are authoritative for pay, so a
 * human decides what actually happened; the midnight cron already handles the
 * one case that can be resolved without judgement.
 *
 * `?staleHours=` overrides the idle gap for the missed-tap check, so the office
 * can widen or tighten it without a deploy.
 */
export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
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
