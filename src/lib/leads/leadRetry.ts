// Website-lead RETRY worker (#leads — GHL-outage recovery). Every submission
// writes its row to Supabase FIRST (source of truth), then attempts the GHL sync
// inline. When that sync fails — a GHL outage (row left 'pending') or a service
// whose pipeline env vars aren't set yet ('deferred') — the row sits waiting. This
// worker re-drives those rows through syncLeadToGhl until they succeed ('synced')
// or exhaust the attempt cap ('failed', terminal — needs manual attention).
//
// Two entry points:
//   * retryStuckLeads() — the Vercel-cron batch pass: SELECT the oldest stuck
//     rows below the cap and re-drive each. (GET /api/leads/retry)
//   * retryOneLead(row) — an operator's manual re-drive of a single row from the
//     /admin/leads page, bypassing the cron's batch query (so an already-'failed'
//     row can still be re-tried by hand). (POST /api/admin/leads/[id]/retry)
//
// Idempotency: syncLeadToGhl's only non-idempotent step is the GHL note. When a
// row already carries a ghl_contact_id (its earlier sync got past contact
// creation), we pass skipNotes:true so the re-drive completes the idempotent
// steps (tags/field/opportunity) without duplicating the note.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { asLeadService, syncLeadToGhl, type LeadInput, type LeadService } from './leadService';

// Statuses the cron pass re-drives. 'spam'/'rate_limited'/'synced'/'failed' are
// deliberately excluded: spam never syncs, synced is done, failed is terminal
// (manual-only), and rate_limited was a deliberate throttle, not an outage.
export const RETRIABLE_STATUSES = ['pending', 'deferred'] as const;

// After this many attempts a still-failing row is parked as 'failed' (terminal)
// so the cron stops churning it and it surfaces on /admin/leads for a human. At
// the 10-min cron cadence this is ~3.3h of automatic recovery — long enough to
// ride out any realistic GHL outage, short enough that a genuinely broken row
// doesn't retry forever.
export const MAX_RETRY_ATTEMPTS = 20;

// Rows re-driven per cron pass. Caps GHL call volume + serverless run time; the
// backlog drains across successive passes (oldest-attempt-first ordering).
export const DEFAULT_RETRY_BATCH = 25;

const LEADS_TABLE = 'website_leads';

export type RetryOutcome = 'synced' | 'deferred' | 'pending' | 'failed';

export type RetryRunSummary = {
  ok: boolean;
  processed: number;
  synced: number;
  deferred: number;
  stillPending: number;
  failed: number;
  error?: string;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// A stored website_leads row → the LeadInput syncLeadToGhl expects. The column
// names differ (landing_url/form_variant) from the camelCase input fields.
function rowToLeadInput(row: Record<string, unknown>, service: LeadService): LeadInput {
  return {
    name: str(row.name),
    email: str(row.email),
    phone: str(row.phone),
    address: strOrNull(row.address),
    service,
    notes: strOrNull(row.notes),
    utm:
      row.utm && typeof row.utm === 'object' && !Array.isArray(row.utm)
        ? (row.utm as Record<string, string>)
        : null,
    landingUrl: strOrNull(row.landing_url),
    formVariant: str(row.form_variant),
  };
}

type SupabaseServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

// Re-drive one row and write the outcome back. Shared by the cron batch and the
// manual admin path — the ONLY difference between them is which rows reach here
// (the cron's SELECT filters; the manual path hands us a specific row).
async function applyRetry(
  sb: SupabaseServiceClient,
  row: Record<string, unknown>,
  now: Date,
): Promise<RetryOutcome> {
  const newRetryCount = (Number(row.retry_count) || 0) + 1;
  const update: Record<string, unknown> = {
    retry_count: newRetryCount,
    last_retried_at: now.toISOString(),
  };

  const service = asLeadService(row.service);
  if (!service) {
    // A row whose service isn't one of the 4 known values can never sync — park
    // it as failed immediately (no GHL call) so it stops being re-selected.
    update.sync_status = 'failed';
    update.sync_error = `Unretriable: unknown service "${str(row.service)}"`;
  } else {
    // Earlier sync got past contact creation → skip the non-idempotent note.
    const skipNotes = Boolean(row.ghl_contact_id);
    try {
      const result = await syncLeadToGhl(rowToLeadInput(row, service), { skipNotes });
      if (result.ghlContactId) update.ghl_contact_id = result.ghlContactId;
      if (result.ghlOpportunityId) update.ghl_opportunity_id = result.ghlOpportunityId;
      if (result.status === 'synced') {
        update.sync_status = 'synced';
        update.sync_error = null;
      } else {
        // 'deferred' (pipeline env still missing) or 'error' (a post-contact step
        // failed — keep 'pending' like the route's own catch does).
        update.sync_status = result.status === 'deferred' ? 'deferred' : 'pending';
        update.sync_error = result.syncError ?? null;
      }
    } catch (err) {
      // upsertContact itself threw — nothing partial, stays 'pending'.
      update.sync_status = 'pending';
      update.sync_error = err instanceof Error ? err.message : 'Unknown HighLevel error';
    }
  }

  // Terminal cap: any non-synced outcome that has now hit the attempt ceiling is
  // parked as 'failed'. Applies to the manual path too (a hand re-drive of a
  // capped row that fails again stays 'failed'); a SUCCESS is never overridden.
  if (update.sync_status !== 'synced' && newRetryCount >= MAX_RETRY_ATTEMPTS) {
    update.sync_status = 'failed';
  }

  await sb.from(LEADS_TABLE).update(update).eq('id', row.id);
  return update.sync_status as RetryOutcome;
}

// Cron batch pass: re-drive the oldest stuck rows below the cap.
export async function retryStuckLeads(opts: { now: Date; batch?: number }): Promise<RetryRunSummary> {
  const sb = getSupabaseServiceClient();
  const empty: RetryRunSummary = { ok: false, processed: 0, synced: 0, deferred: 0, stillPending: 0, failed: 0 };
  if (!sb) return { ...empty, error: 'Supabase service role not configured' };

  const batch = opts.batch ?? DEFAULT_RETRY_BATCH;
  const { data: rows, error } = await sb
    .from(LEADS_TABLE)
    .select('*')
    .in('sync_status', RETRIABLE_STATUSES)
    .lt('retry_count', MAX_RETRY_ATTEMPTS)
    // Oldest attempt first (nulls = never-retried, most urgent) so the backlog
    // drains fairly instead of the same recent rows being re-hit every pass.
    .order('last_retried_at', { ascending: true, nullsFirst: true })
    .limit(batch);

  if (error) return { ...empty, error: error.message };

  const summary: RetryRunSummary = { ok: true, processed: 0, synced: 0, deferred: 0, stillPending: 0, failed: 0 };
  for (const row of rows ?? []) {
    const outcome = await applyRetry(sb, row as Record<string, unknown>, opts.now);
    summary.processed += 1;
    if (outcome === 'synced') summary.synced += 1;
    else if (outcome === 'deferred') summary.deferred += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else summary.stillPending += 1;
  }
  return summary;
}

// Manual single-row re-drive from /admin/leads. Bypasses the cron's SELECT so an
// operator can re-try an already-'failed' row by hand.
export async function retryOneLead(
  row: Record<string, unknown>,
  opts: { now: Date },
): Promise<RetryOutcome> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  return applyRetry(sb, row, opts.now);
}
