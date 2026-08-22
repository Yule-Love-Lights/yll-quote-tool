import { createHmac } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalOpsTarget, createOpsCursor, OPS_CONTRACT_VERSION, OPS_SCHEMA_VERSION, opsHmacInput, parseOpsCursor, verifyOpsMachineRequest } from './opsMachineAuth';

const KEY_ID = 'hub-test-v1';
const SECRET = '12345678901234567890123456789012';
const NOW = 1_787_097_660_000;
const TARGET = '/api/ops/v1/quote-events?limit=1&since=abc%2Fdef';
const NONCE = 'EBESExQVFhcYGRobHB0eHw';

function headers(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    'x-yll-key-id': KEY_ID,
    'x-yll-timestamp': String(NOW / 1000),
    'x-yll-nonce': NONCE,
    'x-yll-contract-version': OPS_CONTRACT_VERSION,
    'x-yll-schema-version': OPS_SCHEMA_VERSION,
    'x-yll-client-version': 'hub-test',
    ...overrides,
  };
  const signature = `v1=${createHmac('sha256', SECRET).update(opsHmacInput({ method: 'GET', target: TARGET, timestamp: values['x-yll-timestamp'], nonce: NONCE, contractVersion: OPS_CONTRACT_VERSION, schemaVersion: OPS_SCHEMA_VERSION, clientVersion: 'hub-test', body: '' }), 'utf8').digest('hex')}`;
  values['x-yll-signature'] = overrides['x-yll-signature'] ?? signature;
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

afterEach(() => { delete process.env.OPS_HUB_MACHINE_KEYS_JSON; delete process.env.OPS_HUB_CURSOR_SECRET; });

describe('canonicalOpsTarget', () => {
  it('accepts only an already-canonical target', () => {
    expect(canonicalOpsTarget(TARGET)).toBe(TARGET);
    expect(canonicalOpsTarget('/api/ops/v1/quote-events?since=abc%2Fdef&limit=1')).toBe(TARGET);
    expect(canonicalOpsTarget('/api/ops/v1/quote-events?limit=1&since=abc%2fdef')).toBe(TARGET);
    expect(canonicalOpsTarget('/api//ops/v1/quote-events?limit=1')).toBeNull();
  });
});

describe('verifyOpsMachineRequest', () => {
  it('accepts a current signed request and rejects version skew', () => {
    process.env.OPS_HUB_MACHINE_KEYS_JSON = JSON.stringify({ [KEY_ID]: SECRET });
    expect(verifyOpsMachineRequest({ method: 'GET', rawTarget: TARGET, body: '', headers: headers(), now: NOW })).toMatchObject({ ok: true, keyId: KEY_ID });
    expect(verifyOpsMachineRequest({ method: 'GET', rawTarget: TARGET, body: '', headers: headers({ 'x-yll-contract-version': '9.0.0' }), now: NOW })).toEqual({ ok: false, status: 409, code: 'contract_version_unsupported' });
  });
});

describe('outbox cursors', () => {
  it('accepts only a cursor signed with the configured cursor secret', () => {
    process.env.OPS_HUB_CURSOR_SECRET = SECRET;
    const cursor = createOpsCursor(42);
    expect(cursor).not.toBeNull();
    expect(parseOpsCursor(cursor!)).toBe(42);
    expect(parseOpsCursor(`${cursor}x`)).toBeNull();
  });
});
