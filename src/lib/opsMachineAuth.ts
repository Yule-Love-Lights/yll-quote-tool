import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const OPS_CONTRACT_VERSION = '1.5.0-draft';
export const OPS_SCHEMA_VERSION = '1.1.0-draft';

type HeadersLike = { get(name: string): string | null };

export type MachineAuthResult =
  | { ok: true; keyId: string; nonce: string; timestamp: number; clientVersion: string }
  | { ok: false; status: 401 | 409; code: 'unauthorized' | 'contract_version_unsupported' | 'schema_version_unsupported' };

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeComponent(value: string): string | null {
  if (/(?:%(?![0-9A-Fa-f]{2}))/.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    return /[\u0000-\u001F\u007F]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Rebuild and validate the exact, signed target from contract §1.4. Callers
 * must compare the returned value with the unmodified incoming target.
 */
export function canonicalOpsTarget(rawTarget: string): string | null {
  if (!rawTarget.startsWith('/') || rawTarget.includes('#') || rawTarget.includes('\\') || /[\u0000-\u001F\u007F]/.test(rawTarget)) return null;
  const queryOffset = rawTarget.indexOf('?');
  const rawPath = queryOffset === -1 ? rawTarget : rawTarget.slice(0, queryOffset);
  const rawQuery = queryOffset === -1 ? null : rawTarget.slice(queryOffset + 1);
  if (rawQuery === '') return null;

  const segments = rawPath === '/' ? [] : rawPath.slice(1).split('/');
  if (segments.some((segment) => segment === '')) return null;
  const pathSegments: string[] = [];
  for (const segment of segments) {
    const decoded = decodeComponent(segment);
    if (decoded === null || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null;
    pathSegments.push(rfc3986Encode(decoded));
  }
  const path = pathSegments.length ? `/${pathSegments.join('/')}` : '/';
  if (rawQuery === null) return path;

  const pairs: Array<[string, string]> = [];
  for (const pair of rawQuery.split('&')) {
    if (!pair || !pair.includes('=') || pair.includes('+')) return null;
    const separator = pair.indexOf('=');
    const key = decodeComponent(pair.slice(0, separator));
    const value = decodeComponent(pair.slice(separator + 1));
    if (key === null || value === null) return null;
    pairs.push([rfc3986Encode(key), rfc3986Encode(value)]);
  }
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  return `${path}?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`;
}

export function opsHmacInput(input: {
  method: string;
  target: string;
  timestamp: string;
  nonce: string;
  contractVersion: string;
  schemaVersion: string;
  clientVersion: string;
  body: string;
}): string {
  const bodyDigest = createHash('sha256').update(input.body, 'utf8').digest('hex');
  return [
    'v1', input.method.toUpperCase(), input.target, input.timestamp, input.nonce,
    input.contractVersion, input.schemaVersion, input.clientVersion, bodyDigest,
  ].join('\n');
}

function secretsFromEnvironment(): Record<string, string> | null {
  const raw = process.env.OPS_HUB_MACHINE_KEYS_JSON;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const valid = Object.entries(parsed).filter(([key, value]) => key.length > 0 && typeof value === 'string' && value.length >= 32);
    return valid.length ? Object.fromEntries(valid) : null;
  } catch {
    return null;
  }
}

function cursorSecret(): string | null {
  const secret = process.env.OPS_HUB_CURSOR_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

/** Opaque, tamper-evident outbox cursor. It identifies order, never time. */
// Naldo's call 2026-08-25. Events carry `customer_ref`, which is
// quotes.customer_id: the PRIMARY KEY of public.customers, a table holding
// name, email, phone and the HighLevel contact id. So the raw value is not an
// anonymous token, it is a stable re-identification key. Anyone with the feed
// and any customer-table access can join straight back to a named homeowner,
// and the same id repeats across every quote forever.
//
// The Ops Hub needs to CORRELATE events per customer, not to identify them, so
// the feed emits a keyed hash instead. Same customer, same hash, so grouping
// and per-customer history still work; no path back to a person without this
// secret.
//
// Fails CLOSED: with no secret configured this returns null and the caller
// OMITS the field rather than falling back to the raw id. A missing env var
// must never be the reason customer identity leaves the building.
export function hashCustomerRef(customerRef: string): string | null {
  const secret = process.env.OPS_HUB_CUSTOMER_REF_SECRET;
  // >= 32 matches the floor opsCursorSecret() already enforces on its sibling.
  // A short key here would be brute-forceable against a known customer id set,
  // which would undo the whole point of hashing.
  if (!secret || secret.length < 32) return null;
  return createHmac('sha256', secret).update(customerRef, 'utf8').digest('base64url').slice(0, 32);
}

// Every authenticated Hub call inserts a nonce and nothing pruned them, so the
// table grew without bound. Rows are dead once expires_at passes (the replay
// window is ten minutes), so clear them opportunistically from each route that
// writes one. Deliberately not awaited: housekeeping must never fail or slow a
// request that already authenticated. Backed by ops_machine_request_nonces_expires_idx.
export function pruneExpiredOpsNonces(sb: {
  from: (t: string) => { delete: () => { lt: (c: string, v: string) => PromiseLike<{ error: { message: string } | null }> } };
}): void {
  void Promise.resolve(
    sb.from('ops_machine_request_nonces').delete().lt('expires_at', new Date().toISOString()),
  ).then(
    ({ error }) => { if (error) console.warn('[opsMachineAuth] nonce prune failed:', error.message); },
    (err) => { console.warn('[opsMachineAuth] nonce prune threw:', err); },
  );
}

export function createOpsCursor(sequence: number): string | null {
  const secret = cursorSecret();
  if (!secret || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  const payload = Buffer.from(String(sequence), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return `${payload}.${mac}`;
}

export function parseOpsCursor(cursor: string): number | null {
  const secret = cursorSecret();
  const parts = cursor.split('.');
  if (!secret || parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const expected = createHmac('sha256', secret).update(parts[0]!, 'utf8').digest('base64url');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(parts[1]!, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const sequence = Number(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  } catch {
    return null;
  }
}

export function verifyOpsMachineRequest(input: {
  method: string;
  rawTarget: string;
  body: string;
  headers: HeadersLike;
  now?: number;
}): MachineAuthResult {
  const keyId = input.headers.get('x-yll-key-id');
  const timestamp = input.headers.get('x-yll-timestamp');
  const nonce = input.headers.get('x-yll-nonce');
  const contractVersion = input.headers.get('x-yll-contract-version');
  const schemaVersion = input.headers.get('x-yll-schema-version');
  const clientVersion = input.headers.get('x-yll-client-version');
  const signature = input.headers.get('x-yll-signature');
  const target = canonicalOpsTarget(input.rawTarget);
  if (!keyId || !timestamp || !nonce || !contractVersion || !schemaVersion || !clientVersion || !signature || !target || target !== input.rawTarget) {
    return { ok: false, status: 401, code: 'unauthorized' };
  }
  if (contractVersion !== OPS_CONTRACT_VERSION) return { ok: false, status: 409, code: 'contract_version_unsupported' };
  if (schemaVersion !== OPS_SCHEMA_VERSION) return { ok: false, status: 409, code: 'schema_version_unsupported' };
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs((input.now ?? Date.now()) - seconds * 1000) > 5 * 60 * 1000) return { ok: false, status: 401, code: 'unauthorized' };
  if (!/^[A-Za-z0-9_-]{22,}$/.test(nonce)) return { ok: false, status: 401, code: 'unauthorized' };
  try {
    if (Buffer.from(nonce, 'base64url').length < 16) return { ok: false, status: 401, code: 'unauthorized' };
  } catch {
    return { ok: false, status: 401, code: 'unauthorized' };
  }
  const secret = secretsFromEnvironment()?.[keyId];
  if (!secret || !/^v1=[0-9a-f]{64}$/.test(signature)) return { ok: false, status: 401, code: 'unauthorized' };
  const expected = `v1=${createHmac('sha256', secret).update(opsHmacInput({ method: input.method, target, timestamp, nonce, contractVersion, schemaVersion, clientVersion, body: input.body }), 'utf8').digest('hex')}`;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(signature, 'utf8');
  if (expectedBytes.length !== receivedBytes.length || !timingSafeEqual(expectedBytes, receivedBytes)) return { ok: false, status: 401, code: 'unauthorized' };
  return { ok: true, keyId, nonce, timestamp: seconds, clientVersion };
}
