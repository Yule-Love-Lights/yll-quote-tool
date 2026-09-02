import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { voidSettlement } from '@/lib/advertising/payouts';

export const runtime = 'nodejs';

/**
 * POST /api/admin/advertising/settlements/[id]/void — undo a payment that
 * was recorded by mistake (ledger row 492).
 *
 * The row stays as the record of what was recorded; it stops counting toward
 * what the worker has been paid, and its photos become payable again. A
 * reason is required, because an unexplained reversal of pay is worse than
 * none. requireAdmin only, and the actor is always the admin session.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'Say why this payment is being undone.' }, { status: 400 });
  }

  try {
    const settlement = await voidSettlement(id, auth.operator.id, reason);
    return NextResponse.json({ settlement });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not undo the payment';
    console.error('POST /api/admin/advertising/settlements/[id]/void:', message);
    const missing = /no settlement found/i.test(message);
    // "Nothing was changed" is only true BEFORE the lines are released. Once
    // they are, the payment already counts as nothing while still reading as
    // live, and the fix is to run the undo again (technical lens, PR #1136).
    const halfDone = /run the undo again/i.test(message);
    return NextResponse.json(
      {
        error: missing
          ? 'That payment no longer exists. Reload the pay screen.'
          : halfDone
            ? 'The photos were released but the payment still shows as live. Undo it again to finish.'
            : 'Could not undo the payment. Nothing was changed.',
      },
      { status: missing ? 404 : 500 },
    );
  }
}
