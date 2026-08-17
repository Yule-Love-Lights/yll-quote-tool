import { NextRequest, NextResponse } from 'next/server';

import { closeForgottenDays } from '@/lib/opsMidnightClose';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

/** Timing-safe-ish equality for the cron bearer, mirroring the sibling crons. */
function safeEqual(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Vercel Cron — midnight auto-close for forgotten days (contract section 4).
 *
 * CRON-ONLY, behind the same Bearer CRON_SECRET guard as the sibling crons
 * (/api/ops/digest, low-stock-alert). Note this path is NOT under /api/ops/v1,
 * so it is not crew-reachable: it lives in the operatorGate PUBLIC allowlist so a
 * cron request (which carries no session at all) can reach its own secret check.
 *
 * Schedule it to run a little AFTER ET midnight rather than exactly at it, so a
 * day that ends at 23:59:59 is safely over. The work is idempotent, so a
 * double-fire or a retry is harmless.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const result = await closeForgottenDays();

  if (result.shiftsClosed > 0) {
    // Worth a log line: every one of these is a forgotten clock-out that a human
    // should look at, not routine housekeeping.
    console.warn(
      `midnight-close: auto-closed ${result.shiftsClosed} forgotten shift(s) ` +
        `(${result.breaksClosed} break(s), ${result.segmentsClosed} segment(s)): ` +
        result.closedShiftIds.join(', '),
    );
  }
  if (result.errors.length) {
    console.error('midnight-close errors:', result.errors.join(' | '));
  }

  return NextResponse.json(result);
}

/** GET behaves identically, so Vercel Cron can be configured either way. */
export const GET = POST;
