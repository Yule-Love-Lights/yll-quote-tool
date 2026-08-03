// src/app/api/jobs/completing-today/route.ts
// Daily "completing today" ping. Vercel Cron hits this GET on the vercel.json
// schedule "0 13 * * *" — Vercel crons run in fixed UTC, so that's 9:00am EDT
// in daylight time / 8:00am EST in standard time (same DST drift as the other
// fixed-UTC crons in this file; see ops/digest's header for the same caveat).
// CRON-ONLY: same Bearer CRON_SECRET guard as the other cron routes.
//
// Keys on jobs.install_date = today's America/New_York calendar date, jobs not
// 'done'/'cancelled'. install_date isn't written by any feature yet (the
// scheduling feature will start writing it later) — so a day with zero matches
// is the norm, not an error, and sends NOTHING (silent). Sending a daily
// "all clear" here would spam the Jobs chat forever until scheduling lands;
// the route still returns 200 with how many jobs matched either way.
//
// Query style mirrors src/lib/jobs.ts (service client, explicit column select,
// batch-join the linked quote for customer identity) — written here directly
// rather than in that file, which this route only reads from (read-only,
// per area ownership: the billing jobs data layer is out of scope to edit).

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { notifyTelegram, appBaseUrl } from '@/lib/integrations/telegramNotify';
import { nyDateString, filterCompletingToday, completingTodayMessage, type CompletingTodayJob } from '@/lib/jobs/completingToday';

export const runtime = 'nodejs';

type Row = {
  id: string;
  job_number: number | null;
  quote_id: string | null;
  status: string;
  install_date: string | null;
};

type Candidate = { id: string; jobNumber: number | null; quoteId: string | null; status: string; installDate: string | null };

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const db = getSupabaseServiceClient()!;
  const today = nyDateString();
  const { data, error } = await db
    .from('jobs')
    .select('id, job_number, quote_id, status, install_date')
    .eq('install_date', today);
  if (error) {
    console.error('[api/jobs/completing-today] query failed:', error);
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 502 });
  }

  const candidates: Candidate[] = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    jobNumber: r.job_number,
    quoteId: r.quote_id,
    status: r.status,
    installDate: r.install_date,
  }));
  const rows = filterCompletingToday(candidates, today);

  const quoteIds = [...new Set(rows.map((r) => r.quoteId).filter((x): x is string => !!x))];
  const custByQuote = new Map<string, { name: string | null; address: string | null }>();
  if (quoteIds.length) {
    const { data: quotes } = await db
      .from('quotes')
      .select('id, customer_name, customer_address')
      .in('id', quoteIds);
    for (const q of (quotes ?? []) as { id: string; customer_name: string | null; customer_address: string | null }[]) {
      custByQuote.set(q.id, { name: q.customer_name ?? null, address: q.customer_address ?? null });
    }
  }

  const jobs: CompletingTodayJob[] = rows.map((r) => {
    const c = r.quoteId ? custByQuote.get(r.quoteId) : undefined;
    return {
      id: r.id,
      jobNumber: r.jobNumber,
      customerName: c?.name ?? null,
      customerAddress: c?.address ?? null,
    };
  });

  const msg = completingTodayMessage(jobs, appBaseUrl());
  if (!msg) return NextResponse.json({ ok: true, matched: 0 });

  if (isTelegramBotEnabled() && isTelegramConfigured()) {
    await notifyTelegram(msg);
  }
  return NextResponse.json({ ok: true, matched: jobs.length });
}
