// src/app/api/ops/crew-day-digest/route.ts
// Daily crew schedule notification. Vercel Cron hits this GET on the
// vercel.json schedule — Vercel crons run in fixed UTC, so the time drifts an
// hour across DST like every other cron in that file.
// CRON-ONLY: same Bearer CRON_SECRET guard as the other cron routes.
//
// Tells the crew what is on today: each crew member with their jobs and
// addresses, plus anything nobody is assigned to yet. Reuses getSchedule() --
// the SAME function the schedule page reads -- so the message and the page can
// never disagree. A quiet day still sends a one-line all-clear, so silence
// means the cron failed rather than "nothing today".

import { NextRequest, NextResponse } from 'next/server';

import { cronDenial } from '@/lib/auth/cronAuth';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import { crewDayDigestMessage } from '@/lib/crew/dayDigest';
import { businessToday, getCrewDay } from '@/lib/crew/dayDigestData';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'telegram dormant' });
  }

  const date = businessToday();
  const { groups, unassigned, errors } = await getCrewDay(date);
  const message = crewDayDigestMessage(date, groups, unassigned);
  await notifyTelegramAudience('jobs', message);

  return NextResponse.json({
    ok: true,
    date,
    crewCount: groups.length,
    jobCount: groups.reduce((n, g) => n + g.jobs.length, 0) + unassigned.length,
    unassignedCount: unassigned.length,
    // Surfaced, not swallowed: a partial read still sends, and the response
    // says what was incomplete so a bad day is visible in the cron log.
    errors,
  });
}
