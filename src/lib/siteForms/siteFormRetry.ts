// Site-submission GHL retry worker (#195).
//
// A submission row is saved BEFORE any GHL call, so nothing is ever lost. What
// used to be lost was the contact tag: if GHL was down at that moment the row
// recorded sync_status 'error' and nothing in the app could re-drive it. Sales
// leads have had a retry cron and a manual admin button for months; these did
// not. This closes that gap with the same shape.
//
// Bounded on purpose: MAX_RETRIES stops a permanently-bad row (a malformed email
// GHL will always reject) from being retried forever, and the row stays visible
// in the admin list with its error either way.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { syncSubmissionToGhl, asSiteFormType } from './siteFormService';

export const MAX_RETRIES = 5;
const BATCH_SIZE = 25;

export type RetrySummary = {
  ok: boolean;
  scanned: number;
  synced: number;
  stillFailing: number;
  exhausted: number;
  error?: string;
};

type Row = {
  id: string;
  form_type: string;
  email: string;
  name: string | null;
  phone: string | null;
  retry_count: number;
};

/**
 * Re-drives submissions whose GHL contact sync never landed.
 *
 * `now` is injected rather than read from the clock so the cron route and the
 * tests share one code path.
 */
export async function retryStuckSubmissions(opts: { now: Date }): Promise<RetrySummary> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, scanned: 0, synced: 0, stillFailing: 0, exhausted: 0, error: 'no supabase' };

  const { data, error } = await sb
    .from('site_submissions')
    .select('id,form_type,email,name,phone,retry_count')
    .in('sync_status', ['pending', 'error'])
    .lt('retry_count', MAX_RETRIES)
    .order('last_retried_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    return { ok: false, scanned: 0, synced: 0, stillFailing: 0, exhausted: 0, error: error.message };
  }

  const rows = (data ?? []) as Row[];
  let synced = 0;
  let stillFailing = 0;
  let exhausted = 0;

  for (const row of rows) {
    const formType = asSiteFormType(row.form_type);
    if (!formType) {
      // Unknown type: mark it done rather than spin on it forever.
      await sb
        .from('site_submissions')
        .update({ sync_status: 'skipped', sync_error: 'unknown form type', last_retried_at: opts.now.toISOString() })
        .eq('id', row.id);
      continue;
    }

    const attempt = (row.retry_count ?? 0) + 1;
    try {
      const { contactId } = await syncSubmissionToGhl({
        formType,
        email: row.email,
        name: row.name,
        phone: row.phone,
      });
      await sb
        .from('site_submissions')
        .update({
          ghl_contact_id: contactId,
          sync_status: contactId ? 'synced' : 'skipped',
          sync_error: null,
          retry_count: attempt,
          last_retried_at: opts.now.toISOString(),
        })
        .eq('id', row.id);
      synced += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const isLast = attempt >= MAX_RETRIES;
      await sb
        .from('site_submissions')
        .update({
          sync_status: 'error',
          sync_error: isLast ? `${message} (gave up after ${attempt} attempts)` : message,
          retry_count: attempt,
          last_retried_at: opts.now.toISOString(),
        })
        .eq('id', row.id);
      if (isLast) exhausted += 1;
      else stillFailing += 1;
    }
  }

  return { ok: true, scanned: rows.length, synced, stillFailing, exhausted };
}
