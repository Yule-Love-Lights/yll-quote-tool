import { NextRequest, NextResponse } from 'next/server';

import { closeForgottenDays } from '@/lib/opsMidnightClose';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';

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
  // Shared guard: 503 (naming the variable) when CRON_SECRET is unset, 401 when
  // the token is merely wrong. See src/lib/auth/cronAuth.ts for why.
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;
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
