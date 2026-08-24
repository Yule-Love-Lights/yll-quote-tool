import { after } from 'next/server';

import { getOperator, type Operator } from './auth/supabaseServer';
import { getSupabaseServiceClient } from './supabase';
import type { QuoteBuildStartReason } from './quoteBuildTimerClient';
import { deriveStatus, isQuoteStatus } from './quoteStatus';

export type QuoteBuildSessionRow = {
  id: string;
  started_at: string;
  start_reason: QuoteBuildStartReason;
  started_by: string | null;
  started_by_label: string;
  quote_id: string | null;
  sent_at: string | null;
};

export type QuoteBuildTimingStat = {
  operatorId: string | null;
  operatorLabel: string;
  count: number;
  averageSeconds: number;
  medianSeconds: number;
  p90Seconds: number;
  /** Sessions left OUT of the figures above for running past the idle cap. */
  excludedCount: number;
};

// Ledger row 374. A session is wall-clock: it runs from accepting the contact
// until the quote is first sent, and nothing pauses it. A staffer who opens a
// draft before lunch and sends it after records the whole span, so without a
// cap the average measures interruption rather than effort, and a single
// resumed draft dominates a person's number.
//
// Sessions past this length are EXCLUDED from the figures rather than clamped.
// Clamping would invent a duration that nobody actually worked; excluding says
// honestly that the session was not a clean measurement. The count of excluded
// sessions is reported alongside, so the exclusion is visible rather than a
// silent trim.
//
// Two hours is deliberately generous for a task normally measured in minutes.
// Change this one constant to retune it.
export const QUOTE_BUILD_IDLE_CAP_SECONDS = 2 * 60 * 60;

export type StartQuoteBuildSessionResult =
  | { ok: true; kind: 'started' | 'existing'; row: QuoteBuildSessionRow }
  | { ok: false; kind: 'conflict' | 'failed' };

export type QuoteBuildSessionTargetState =
  | { kind: 'draft' }
  | { kind: 'sent'; sentAt: string }
  | { kind: 'ineligible' };

const SESSION_COLUMNS =
  'id, started_at, start_reason, started_by, started_by_label, quote_id, sent_at';
const PAGE_SIZE = 1000;
const DB_TIMEOUT_MS = 5_000;

function withDbTimeout<T>(build: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  return Promise.resolve(build(controller.signal)).finally(() => clearTimeout(timeout));
}

function operatorLabel(operator: Pick<Operator, 'name' | 'email'>): string {
  return operator.name?.trim() || operator.email?.trim() || 'Staff';
}

export async function quoteBuildSessionTargetState(
  quoteId: string,
): Promise<QuoteBuildSessionTargetState | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  try {
    const { data, error } = await withDbTimeout((signal) =>
      sb
        .from('quotes')
        .select('status, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, is_test, view_only')
        .eq('id', quoteId)
        .abortSignal(signal)
        .maybeSingle<{
          status: string | null;
          quote_sent_at: string | null;
          customer_approved_at: string | null;
          deposit_paid_at: string | null;
          viewed_at: string | null;
          is_test: boolean;
          view_only: boolean;
        }>(),
    );
    if (error) {
      console.warn('[quoteBuildTiming] target lookup failed:', error.message);
      return null;
    }
    if (!data || data.is_test !== false || data.view_only !== false) {
      return { kind: 'ineligible' };
    }
    if (data.quote_sent_at) return { kind: 'sent', sentAt: data.quote_sent_at };
    const status = deriveStatus({
      ...data,
      status: isQuoteStatus(data.status) ? data.status : null,
    });
    return status === 'draft' ? { kind: 'draft' } : { kind: 'ineligible' };
  } catch (error) {
    console.warn('[quoteBuildTiming] target lookup threw:', error);
    return null;
  }
}

export async function startQuoteBuildSession(input: {
  timerId: string;
  startReason: QuoteBuildStartReason;
  operator: Pick<Operator, 'id' | 'name' | 'email'>;
  quoteId?: string;
  startedAt?: string;
}): Promise<StartQuoteBuildSessionResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, kind: 'failed' };

  try {
    const { data, error } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .insert({
          id: input.timerId,
          start_reason: input.startReason,
          started_by: input.operator.id,
          started_by_label: operatorLabel(input.operator),
          quote_id: input.quoteId ?? null,
          ...(input.startedAt ? { started_at: input.startedAt } : {}),
        })
        .select(SESSION_COLUMNS)
        .abortSignal(signal)
        .single<QuoteBuildSessionRow>(),
    );

    if (!error && data) return { ok: true, kind: 'started', row: data };
    if (error?.code !== '23505') {
      console.warn('[quoteBuildTiming] start failed:', error?.message ?? 'no row');
      return { ok: false, kind: 'failed' };
    }

    const { data: existing, error: readError } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .select(SESSION_COLUMNS)
        .eq('id', input.timerId)
        .abortSignal(signal)
        .maybeSingle<QuoteBuildSessionRow>(),
    );
    if (readError) {
      console.warn('[quoteBuildTiming] duplicate lookup failed:', readError.message);
      return { ok: false, kind: 'failed' };
    }
    if (existing?.started_by === input.operator.id) {
      const requestedStart = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
      const storedStart = Date.parse(existing.started_at);
      if (
        input.startedAt &&
        Number.isFinite(requestedStart) &&
        Number.isFinite(storedStart) &&
        requestedStart < storedStart
      ) {
        const { data: corrected, error: correctionError } = await withDbTimeout((signal) =>
          sb
            .from('quote_build_sessions')
            .update({ started_at: input.startedAt })
            .eq('id', input.timerId)
            .eq('started_by', input.operator.id)
            .gt('started_at', input.startedAt!)
            .select(SESSION_COLUMNS)
            .abortSignal(signal)
            .maybeSingle<QuoteBuildSessionRow>(),
        );
        if (correctionError) {
          console.warn('[quoteBuildTiming] earlier-start correction failed:', correctionError.message);
          return { ok: false, kind: 'failed' };
        }
        if (corrected) return { ok: true, kind: 'existing', row: corrected };
      }
      return { ok: true, kind: 'existing', row: existing };
    }
    if (!existing && input.quoteId) {
      const { data: quoteSession, error: quoteReadError } = await withDbTimeout((signal) =>
        sb
          .from('quote_build_sessions')
          .select(SESSION_COLUMNS)
          .eq('quote_id', input.quoteId!)
          .abortSignal(signal)
          .maybeSingle<QuoteBuildSessionRow>(),
      );
      if (quoteReadError) {
        console.warn('[quoteBuildTiming] quote-session lookup failed:', quoteReadError.message);
        return { ok: false, kind: 'failed' };
      }
      if (quoteSession) return { ok: true, kind: 'existing', row: quoteSession };
    }
    return { ok: false, kind: 'conflict' };
  } catch (error) {
    console.warn('[quoteBuildTiming] start threw:', error);
    return { ok: false, kind: 'failed' };
  }
}

export async function getOwnedQuoteBuildSession(input: {
  timerId: string;
  operatorId: string;
}): Promise<QuoteBuildSessionRow | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  try {
    const { data, error } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .select(SESSION_COLUMNS)
        .eq('id', input.timerId)
        .eq('started_by', input.operatorId)
        .abortSignal(signal)
        .maybeSingle<QuoteBuildSessionRow>(),
    );
    if (error) {
      console.warn('[quoteBuildTiming] owned timer lookup failed:', error.message);
      return null;
    }
    return data ?? null;
  } catch (error) {
    console.warn('[quoteBuildTiming] owned timer lookup threw:', error);
    return null;
  }
}

export async function linkQuoteBuildSession(input: {
  timerId: string;
  quoteId: string;
  operatorId: string;
}): Promise<boolean> {
  const sb = getSupabaseServiceClient();
  if (!sb) return false;
  try {
    const { data, error } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .update({ quote_id: input.quoteId })
        .eq('id', input.timerId)
        .eq('started_by', input.operatorId)
        .is('sent_at', null)
        .is('quote_id', null)
        .select(SESSION_COLUMNS)
        .abortSignal(signal)
        .maybeSingle<QuoteBuildSessionRow>(),
    );
    if (!error && data) return data.quote_id === input.quoteId;
    if (error && error.code !== '23505') {
      console.warn('[quoteBuildTiming] link failed:', error.message);
      return false;
    }

    const { data: existing, error: readError } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .select(SESSION_COLUMNS)
        .eq(error?.code === '23505' ? 'quote_id' : 'id', error?.code === '23505' ? input.quoteId : input.timerId)
        .abortSignal(signal)
        .maybeSingle<QuoteBuildSessionRow>(),
    );
    if (readError) {
      console.warn('[quoteBuildTiming] link lookup failed:', readError.message);
      return false;
    }
    if (error?.code === '23505') return existing?.quote_id === input.quoteId && existing.sent_at == null;
    return existing?.started_by === input.operatorId && existing.quote_id === input.quoteId && existing.sent_at == null;
  } catch (error) {
    console.warn('[quoteBuildTiming] link threw:', error);
    return false;
  }
}

async function completeLinkedSession(
  quoteId: string,
  sentAt: string,
  operatorId: string | null,
): Promise<boolean> {
  const sb = getSupabaseServiceClient();
  if (!sb) return false;
  // Admin-lens HIGH: this used to match on quote_id alone. When a second
  // staffer reopened and sent a draft the first staffer had started, the
  // FIRST staffer's session was stamped with the SECOND staffer's send time,
  // so /insights credited or blamed the wrong named person with no signal
  // that it had happened. The session only completes for the person who
  // started it. A handover therefore records NO row rather than a wrong one:
  // a missing measurement is honest, a misattributed one is not.
  if (!operatorId) return false;
  const { data, error } = await withDbTimeout((signal) =>
    sb
      .from('quote_build_sessions')
      .update({ sent_at: sentAt })
      .eq('quote_id', quoteId)
      .eq('started_by', operatorId)
      .is('sent_at', null)
      .select('id')
      .abortSignal(signal)
      .maybeSingle<{ id: string }>(),
  );
  if (error) {
    console.warn('[quoteBuildTiming] completion failed:', error.message);
    return false;
  }
  return data != null;
}

export async function completeQuoteBuildSession(input: {
  quoteId: string;
  timerId: string | null;
  operatorId: string | null;
  sentAt: string;
}): Promise<boolean> {
  try {
    if (await completeLinkedSession(input.quoteId, input.sentAt, input.operatorId)) return true;
    if (!input.timerId || !input.operatorId) return false;

    const sb = getSupabaseServiceClient();
    if (!sb) return false;
    const { data, error } = await withDbTimeout((signal) =>
      sb
        .from('quote_build_sessions')
        .update({ quote_id: input.quoteId, sent_at: input.sentAt })
        .eq('id', input.timerId!)
        .eq('started_by', input.operatorId!)
        .is('quote_id', null)
        .is('sent_at', null)
        .select('id')
        .abortSignal(signal)
        .maybeSingle<{ id: string }>(),
    );
    if (!error && data) return true;
    if (error?.code === '23505') {
      return await completeLinkedSession(input.quoteId, input.sentAt, input.operatorId);
    }
    if (error) console.warn('[quoteBuildTiming] fallback completion failed:', error.message);
    return false;
  } catch (error) {
    console.warn('[quoteBuildTiming] completion threw:', error);
    return false;
  }
}

export function queueQuoteBuildSessionCompletion(input: {
  quoteId: string;
  timerId: string | null;
  sentAt: string;
}): void {
  after(async () => {
    try {
      const operator = input.timerId ? await getOperator() : null;
      await completeQuoteBuildSession({ ...input, operatorId: operator?.id ?? null });
    } catch (error) {
      console.warn('[quoteBuildTiming] queued completion threw:', error);
    }
  });
}

function percentile(sorted: number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeQuoteBuildTimingStats(rows: QuoteBuildSessionRow[]): QuoteBuildTimingStat[] {
  const groups = new Map<
    string,
    {
      operatorId: string | null;
      operatorLabel: string;
      labelAt: number;
      durations: number[];
      excludedCount: number;
    }
  >();

  for (const row of rows) {
    if (!row.sent_at) continue;
    const started = Date.parse(row.started_at);
    const sent = Date.parse(row.sent_at);
    if (!Number.isFinite(started) || !Number.isFinite(sent) || sent < started) continue;
    const key = row.started_by ?? `former:${row.started_by_label}`;
    const group = groups.get(key) ?? {
      operatorId: row.started_by,
      operatorLabel: row.started_by_label,
      labelAt: sent,
      durations: [],
      excludedCount: 0,
    };
    if (sent > group.labelAt) {
      group.operatorLabel = row.started_by_label;
      group.labelAt = sent;
    }
    const seconds = (sent - started) / 1000;
    if (seconds > QUOTE_BUILD_IDLE_CAP_SECONDS) group.excludedCount += 1;
    else group.durations.push(seconds);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.durations].sort((a, b) => a - b);
      // A staffer whose every session ran past the cap still appears, with a
      // zero count and the excluded tally, rather than vanishing from the table
      // as though they had built nothing.
      if (sorted.length === 0) {
        return {
          operatorId: group.operatorId,
          operatorLabel: group.operatorLabel,
          count: 0,
          averageSeconds: 0,
          medianSeconds: 0,
          p90Seconds: 0,
          excludedCount: group.excludedCount,
        };
      }
      return {
        operatorId: group.operatorId,
        operatorLabel: group.operatorLabel,
        count: sorted.length,
        averageSeconds: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
        medianSeconds: median(sorted),
        p90Seconds: percentile(sorted, 0.9),
        excludedCount: group.excludedCount,
      };
    })
    .sort((a, b) => a.operatorLabel.localeCompare(b.operatorLabel));
}

export type QuoteBuildTimingResult =
  | { ok: true; stats: QuoteBuildTimingStat[] }
  | { ok: false; error: string };

export async function listQuoteBuildTimingStats(
  operator: Pick<Operator, 'id'> | null,
): Promise<QuoteBuildTimingResult> {
  if (!operator) return { ok: false, error: 'Unauthorized' };
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase is not configured.' };

  try {
    const rows: QuoteBuildSessionRow[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await withDbTimeout((signal) =>
        sb
          .from('quote_build_sessions')
          .select(SESSION_COLUMNS)
          .not('sent_at', 'is', null)
          .order('sent_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1)
          .abortSignal(signal),
      );
      if (error) {
        console.error('[quoteBuildTiming] stats read failed:', error);
        return { ok: false, error: error.message };
      }
      const page = (data ?? []) as unknown as QuoteBuildSessionRow[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return { ok: true, stats: computeQuoteBuildTimingStats(rows) };
  } catch (error) {
    console.error('[quoteBuildTiming] stats read threw:', error);
    return { ok: false, error: error instanceof Error ? error.message : 'Quote timing query failed' };
  }
}
