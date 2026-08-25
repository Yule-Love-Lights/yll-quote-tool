import { NextRequest, NextResponse } from 'next/server';

import { createOpsCursor, hashCustomerRef, OPS_CONTRACT_VERSION, OPS_SCHEMA_VERSION, parseOpsCursor, verifyOpsMachineRequest } from '@/lib/opsMachineAuth';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 100;

type EventRow = {
  id: string;
  quote_id: string | null;
  quote_request_id: string | null;
  event_type: string;
  entity_version: number;
  occurred_at: string;
  accepted_at: string;
  actor_employee_id: string | null;
  source: 'hub_pwa' | 'telegram' | 'office' | 'admin' | 'system';
  idempotency_key: string;
  correlation_id: string;
  causation_id: string | null;
  payload: Record<string, unknown>;
};

type OutboxRow = { sequence: number; quote_lifecycle_events: EventRow | null };

function rawTarget(request: NextRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function fail(status: number, code: string, clientVersion: string | null = null) {
  return NextResponse.json({
    error_code: code,
    contract_version: OPS_CONTRACT_VERSION,
    schema_version: OPS_SCHEMA_VERSION,
    client_version: clientVersion ?? 'unknown',
    correlation_id: crypto.randomUUID(),
  }, { status });
}

// The stored event keeps the raw customer_ref, which is ours and useful for
// internal audit. Only what LEAVES is hashed, and this is the single boundary
// it leaves through.
function redactCustomerRef(payload: Record<string, unknown>): Record<string, unknown> {
  const { customer_ref: customerRef, ...rest } = payload;
  if (typeof customerRef !== 'string' || customerRef.length === 0) return rest;
  const hashed = hashCustomerRef(customerRef);
  return hashed ? { ...rest, customer_ref_hash: hashed } : rest;
}

export async function GET(request: NextRequest) {
  const target = rawTarget(request);
  const auth = verifyOpsMachineRequest({ method: 'GET', rawTarget: target, body: '', headers: request.headers });
  if (!auth.ok) return fail(auth.status, auth.code, request.headers.get('x-yll-client-version'));
  if (process.env.QUOTE_LIFECYCLE_EVENTS_ENABLED !== 'true') return fail(503, 'kill_switched', auth.clientVersion);
  if (!isSupabaseServiceConfigured()) return fail(503, 'service_unavailable', auth.clientVersion);

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]{1,2})$/.test(rawLimit)) return fail(400, 'validation_failed', auth.clientVersion);
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (limit < 1 || limit > 500) return fail(400, 'validation_failed', auth.clientVersion);
  const rawCursor = url.searchParams.get('since');
  const sequence = rawCursor === null ? 0 : parseOpsCursor(rawCursor);
  if (sequence === null) return fail(410, 'cursor_expired', auth.clientVersion);

  const sb = getSupabaseServiceClient()!;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error: nonceError } = await sb
    .from('ops_machine_request_nonces')
    .insert({ key_id: auth.keyId, nonce: auth.nonce, expires_at: expiresAt });
  if (nonceError) return fail(401, 'unauthorized', auth.clientVersion);

  const { data, error } = await sb
    .from('quote_event_outbox')
    .select('sequence, quote_lifecycle_events(*)')
    .gt('sequence', sequence)
    .is('dead_lettered_at', null)
    .order('sequence', { ascending: true })
    .limit(limit + 1);
  if (error) {
    console.error('[api/ops/v1/quote-events] query failed:', error);
    return fail(500, 'internal', auth.clientVersion);
  }

  const rows = (data ?? []) as unknown as OutboxRow[];
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const eventRows = page.filter((row): row is OutboxRow & { quote_lifecycle_events: EventRow } => row.quote_lifecycle_events !== null);
  if (eventRows.length !== page.length) {
    console.error('[api/ops/v1/quote-events] outbox row missing immutable event');
    return fail(500, 'internal', auth.clientVersion);
  }
  const lastSequence = eventRows.at(-1)?.sequence ?? sequence;
  const nextCursor = hasMore ? createOpsCursor(lastSequence) : null;
  if (hasMore && !nextCursor) return fail(503, 'service_unavailable', auth.clientVersion);

  return NextResponse.json({
    events: eventRows.map(({ sequence: outboxSequence, quote_lifecycle_events: event }) => ({
      event_id: event.id,
      event_type: event.event_type,
      aggregate_id: event.quote_id ?? event.quote_request_id,
      entity_version: event.entity_version,
      occurred_at: event.occurred_at,
      effective_at: event.occurred_at,
      accepted_at: event.accepted_at,
      actor_employee_id: event.actor_employee_id,
      source: event.source,
      contract_version: OPS_CONTRACT_VERSION,
      schema_version: OPS_SCHEMA_VERSION,
      client_version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'quote-tool',
      correlation_id: event.correlation_id,
      causation_id: event.causation_id,
      idempotency_key: event.idempotency_key,
      quote_id: event.quote_id,
      request_id: event.quote_request_id,
      source_outbox_sequence: outboxSequence,
      ...redactCustomerRef(event.payload),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
    source_watermark: String(lastSequence),
    contract_version: OPS_CONTRACT_VERSION,
    schema_version: OPS_SCHEMA_VERSION,
    client_version: auth.clientVersion,
    correlation_id: crypto.randomUUID(),
  });
}
