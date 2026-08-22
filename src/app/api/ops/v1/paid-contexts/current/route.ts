import { NextRequest, NextResponse } from 'next/server';

import { OPS_CONTRACT_VERSION, OPS_SCHEMA_VERSION, verifyOpsMachineRequest } from '@/lib/opsMachineAuth';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function result(status: number, body: Record<string, unknown>) {
  return NextResponse.json({ contract_version: OPS_CONTRACT_VERSION, schema_version: OPS_SCHEMA_VERSION, ...body }, { status });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const auth = verifyOpsMachineRequest({ method: 'GET', rawTarget: `${url.pathname}${url.search}`, body: '', headers: request.headers });
  if (!auth.ok) return result(auth.status, { error_code: auth.code, client_version: request.headers.get('x-yll-client-version') ?? 'unknown', correlation_id: crypto.randomUUID() });
  if (process.env.QUOTE_PAID_CONTEXTS_ENABLED !== 'true') {
    return result(503, { error_code: 'kill_switched', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  }
  if (!isSupabaseServiceConfigured()) return result(503, { error_code: 'internal', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  const employeeId = url.searchParams.get('employee_id');
  if (!employeeId || !UUID_RE.test(employeeId)) return result(400, { error_code: 'validation_failed', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });

  const sb = getSupabaseServiceClient()!;
  const { error: nonceError } = await sb.from('ops_machine_request_nonces').insert({
    key_id: auth.keyId, nonce: auth.nonce, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (nonceError) return result(401, { error_code: 'unauthorized', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });

  // Current shifts do not yet carry the Hub-owned department/context UUIDs
  // required by Flow Q. Returning unavailable is intentional and safe: it
  // never grants access by inferring work from a clock timestamp or role text.
  const { data: employee, error } = await sb
    .from('crew_members')
    .select('hub_employee_id')
    .eq('hub_employee_id', employeeId)
    .maybeSingle<{ hub_employee_id: string | null }>();
  if (error) {
    console.error('[api/ops/v1/paid-contexts/current] employee lookup failed:', error);
    return result(500, { error_code: 'internal', client_version: auth.clientVersion, correlation_id: crypto.randomUUID() });
  }
  return result(200, {
    status: 'unavailable',
    employee_id: employeeId,
    unavailable_reason: employee?.hub_employee_id ? 'context_data_unavailable' : 'employee_unlinked',
    source_watermark: '0',
    client_version: auth.clientVersion,
    correlation_id: crypto.randomUUID(),
  });
}
