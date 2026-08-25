import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { OPS_CONTRACT_VERSION, OPS_SCHEMA_VERSION, verifyOpsMachineRequest } from '@/lib/opsMachineAuth';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITIES = new Set([
  'internal_public.read', 'office.tools.use', 'office.analytics.read', 'office.calls.work', 'office.customer.search',
  'office.coaching.self', 'office.coaching.team.read', 'office.coaching.settings.manage', 'office.knowledge.read',
  'office.knowledge.manage', 'office.pipeline.run', 'office.scoreboard.self', 'office.scoreboard.manage',
  'office.second_mile.work', 'office.second_mile.send', 'office.job_operations', 'advertising.navigation',
  'installer.navigation', 'operations.admin',
]);

type Snapshot = {
  snapshot_id: string; employee_id: string; entity_version: number; authorization_policy_version: string;
  capabilities: string[]; effective_at: string; idempotency_key: string; correlation_id: string;
  contract_version: string; schema_version: string; client_version: string;
};

function response(status: number, body: Record<string, unknown>) {
  return NextResponse.json({ contract_version: OPS_CONTRACT_VERSION, schema_version: OPS_SCHEMA_VERSION, ...body }, { status });
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const capabilities = candidate.capabilities;
  return UUID_RE.test(String(candidate.snapshot_id ?? ''))
    && UUID_RE.test(String(candidate.employee_id ?? ''))
    && UUID_RE.test(String(candidate.correlation_id ?? ''))
    && Number.isInteger(candidate.entity_version) && Number(candidate.entity_version) >= 1
    && typeof candidate.authorization_policy_version === 'string' && candidate.authorization_policy_version.length > 0
    && Array.isArray(capabilities) && capabilities.every((capability) => typeof capability === 'string' && CAPABILITIES.has(capability))
    && new Set(capabilities).size === capabilities.length
    && typeof candidate.effective_at === 'string' && !Number.isNaN(Date.parse(candidate.effective_at))
    && typeof candidate.idempotency_key === 'string' && candidate.idempotency_key.length > 0
    && candidate.contract_version === OPS_CONTRACT_VERSION
    && candidate.schema_version === OPS_SCHEMA_VERSION
    && typeof candidate.client_version === 'string' && candidate.client_version.length > 0;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const url = new URL(request.url);
  const auth = verifyOpsMachineRequest({ method: 'POST', rawTarget: `${url.pathname}${url.search}`, body: rawBody, headers: request.headers });
  if (!auth.ok) return response(auth.status, { error_code: auth.code, client_version: request.headers.get('x-yll-client-version') ?? 'unknown', correlation_id: crypto.randomUUID() });
  // Technical lens: this is the only MUTATING route of the three and was the
  // only one without a kill switch, so a misbehaving Hub could not be shut off
  // without a deploy. Same shape as QUOTE_LIFECYCLE_EVENTS_ENABLED on the feed.
  if (process.env.EMPLOYEE_AUTHORIZATION_SNAPSHOTS_ENABLED !== 'true') {
    return response(503, { error_code: 'kill_switch', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  }
  if (!isSupabaseServiceConfigured()) return response(503, { error_code: 'internal', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  let input: unknown;
  try { input = JSON.parse(rawBody); } catch { return response(400, { error_code: 'validation_failed', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() }); }
  if (!isSnapshot(input) || input.client_version !== auth.clientVersion) {
    return response(400, { error_code: 'validation_failed', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  }

  const sb = getSupabaseServiceClient()!;
  const { error: nonceError } = await sb.from('ops_machine_request_nonces').insert({
    key_id: auth.keyId, nonce: auth.nonce, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (nonceError) return response(401, { error_code: 'unauthorized', client_version: auth.clientVersion, correlation_id: input.correlation_id });
  // The nonce table grows one row per authenticated Hub call and nothing pruned
  // it. Rows are dead the moment expires_at passes (the replay window is ten
  // minutes), so clear the expired ones opportunistically here. Best-effort and
  // deliberately un-awaited for failure: a housekeeping problem must never fail
  // a request that already authenticated.
  void sb
    .from('ops_machine_request_nonces')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .then(({ error }) => {
      if (error) console.warn('[ops/snapshots] nonce prune failed:', error.message);
    });
  const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const { data: idempotent } = await sb
    .from('employee_authorization_snapshots')
    .select('employee_id, entity_version, authorization_policy_version, payload_hash')
    .eq('idempotency_key', input.idempotency_key)
    .maybeSingle<{ employee_id: string; entity_version: number; authorization_policy_version: string; payload_hash: string }>();
  if (idempotent) {
    if (idempotent.payload_hash !== payloadHash) return response(409, { error_code: 'conflict_idempotency', client_version: auth.clientVersion, correlation_id: input.correlation_id });
    return response(200, { status: 'accepted', employee_id: idempotent.employee_id, entity_version: idempotent.entity_version, authorization_policy_version: idempotent.authorization_policy_version, client_version: auth.clientVersion, correlation_id: input.correlation_id });
  }

  const { data: current } = await sb
    .from('employee_authorization_snapshots')
    .select('entity_version, authorization_policy_version')
    .eq('employee_id', input.employee_id)
    .order('entity_version', { ascending: false })
    .limit(1)
    .maybeSingle<{ entity_version: number; authorization_policy_version: string }>();
  if (current && input.entity_version <= current.entity_version) {
    return response(200, { status: 'superseded', employee_id: input.employee_id, entity_version: current.entity_version, authorization_policy_version: current.authorization_policy_version, client_version: auth.clientVersion, correlation_id: input.correlation_id });
  }

  const { error } = await sb.from('employee_authorization_snapshots').insert({
    snapshot_id: input.snapshot_id, employee_id: input.employee_id, entity_version: input.entity_version,
    authorization_policy_version: input.authorization_policy_version, snapshot: input, idempotency_key: input.idempotency_key,
    payload_hash: payloadHash, effective_at: input.effective_at, source_key_id: auth.keyId,
  });
  if (error) {
    console.error('[api/ops/v1/employee-authorization-snapshots] insert failed:', error);
    return response(500, { error_code: 'internal', client_version: auth.clientVersion, correlation_id: input.correlation_id });
  }
  return response(200, { status: 'accepted', employee_id: input.employee_id, entity_version: input.entity_version, authorization_policy_version: input.authorization_policy_version, client_version: auth.clientVersion, correlation_id: input.correlation_id });
}
