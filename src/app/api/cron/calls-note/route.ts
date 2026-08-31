// GET /api/cron/calls-note: posts the internal HighLevel note for calls
// that have been transcribed and commitment-extracted but not yet noted
// (Naldo's ask, 2026-08-29). Same shape as /api/cron/calls-sync and
// /api/cron/calls-extract: GET only (Vercel Cron only ever issues GET),
// allowlisted in operatorGate.ts (a cron request carries no operator
// session), CRON_SECRET-guarded via cronDenial.
//
// THE FLAG DEFAULTS ON, unlike its two siblings. The calls plan's decision
// 5 makes each pipeline's flag default OFF so a deploy runs nothing until
// Naldo turns each timer on; here Naldo asked for the opposite in as many
// words, that notes go fully automatic on merge. So CALLS_NOTES_ENABLED is
// an OFF switch: set it to 'false' to stop the notes, and it needs no
// setting at all for them to run. Deviating from the plan's default is a
// deliberate answer to a direct instruction, not an oversight.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isClaudeConfigured } from '@/lib/claude';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { postPendingCallNotes, CALL_NOTE_BATCH_SIZE } from '@/lib/calls/postNotes';
import { isCallNotesSchemaUnavailable } from '@/lib/calls/errors';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';
// Up to CALL_NOTE_BATCH_SIZE (6) calls, each at most one Haiku summary plus
// one HighLevel round trip. Same budget as the sibling extract route.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  if (process.env.CALLS_NOTES_ENABLED === 'false') {
    return NextResponse.json({ ran: false, reason: 'CALLS_NOTES_ENABLED is set to false.' });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ran: false, reason: 'Supabase not configured.' });
  }
  if (!isClaudeConfigured()) {
    return NextResponse.json({ ran: false, reason: 'Claude not configured.' });
  }
  // Checked here rather than per call: without HighLevel credentials every
  // call in the batch would burn a claim attempt and march toward
  // quarantine for a reason that has nothing to do with the call.
  if (!isHighLevelConfigured()) {
    return NextResponse.json({ ran: false, reason: 'HighLevel not configured.' });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const result = await postPendingCallNotes(supabase, CALL_NOTE_BATCH_SIZE);
    return NextResponse.json({ ran: true, ...result });
  } catch (err) {
    if (isCallNotesSchemaUnavailable(err)) {
      return NextResponse.json({
        ran: false,
        migrated: false,
        reason: 'Run migrations/2026-08-29-call-notes.sql first.',
      });
    }
    console.error('Cron calls-note failed:', err);
    return NextResponse.json({ ran: false, error: 'Posting call notes failed.' }, { status: 500 });
  }
}
