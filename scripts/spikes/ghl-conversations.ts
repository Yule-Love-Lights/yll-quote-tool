// SPIKE — GoHighLevel Conversations READ API (dashboard #58 / inbox).
//
// PURPOSE: de-risk the highest-uncertainty piece of the Unified Customer
// Dashboard before we write ingestion code — does the live GHL API actually
// return what the plan assumes for "unresponded customer touch" detection?
//
// READ-ONLY. This script performs only GET requests:
//   (a) GET /conversations/search            → list conversations for the location
//   (b) GET /conversations/{id}/messages     → messages of one conversation
// It NEVER mutates GHL. The mark-read call (a PUT) is only PRINTED as the exact
// request we WOULD make, then the script stops. Do not un-comment it without a
// human go-ahead — marking read changes the owner's real inbox.
//
// RUN:  npx tsx scripts/spikes/ghl-conversations.ts
// Creds are read from .env.local (HIGHLEVEL_API_KEY + HIGHLEVEL_LOCATION_ID),
// discovered by walking up from the cwd (works from a git worktree, where
// .env.local lives in the parent checkout). No values are ever printed.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

const API_BASE = 'https://services.leadconnectorhq.com';
// The conversations endpoints historically use a different Version header than
// contacts/opportunities — mirror the value the app already uses for sends.
const CONVERSATIONS_API_VERSION = '2021-04-15';

// ── tiny .env.local loader (no dependency) ─────────────────────────────────
function findEnvFile(): string | null {
  let dir = process.cwd();
  // Walk up to the filesystem root looking for a .env.local.
  for (;;) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) return null;
    dir = parent;
  }
}

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ── PII masking (this is the owner's real customer data) ───────────────────
function maskEmail(v: unknown): unknown {
  if (typeof v !== 'string' || !v.includes('@')) return v;
  const [u, d] = v.split('@');
  return `${u.slice(0, 1)}***@${d}`;
}
function maskPhone(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}
function truncate(v: unknown, n = 60): unknown {
  return typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v;
}
/** Describe an object's keys + JS types — the spike's primary output. */
function shapeOf(obj: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    shape[k] = Array.isArray(val) ? `array[${val.length}]` : val === null ? 'null' : typeof val;
  }
  return shape;
}
/** A single sample row, with PII fields masked but structure intact. */
function maskRow(obj: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes('email')) masked[k] = maskEmail(val);
    else if (lk.includes('phone')) masked[k] = maskPhone(val);
    else if (lk.includes('body') || lk.includes('name') || lk.includes('snippet')) masked[k] = truncate(val);
    else masked[k] = truncate(val, 80);
  }
  return masked;
}

async function ghlGet(path: string, apiKey: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: CONVERSATIONS_API_VERSION,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null; raw text printed on error */
  }
  return { status: res.status, json, text };
}

function firstArray(json: unknown): { key: string; rows: Record<string, unknown>[] } | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  // Common GHL shapes: { conversations: [...] } | { messages: [...] } |
  // { messages: { messages: [...] } }.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return { key: k, rows: v as Record<string, unknown>[] };
    if (v && typeof v === 'object') {
      const inner = firstArray(v);
      if (inner) return { key: `${k}.${inner.key}`, rows: inner.rows };
    }
  }
  return null;
}

function hr(label: string): void {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
}

async function main(): Promise<void> {
  const envFile = findEnvFile();
  if (!envFile) {
    console.error('✗ Could not find .env.local by walking up from cwd.');
    process.exit(1);
  }
  console.log(`env: ${envFile}`);
  const env = loadEnv(envFile);
  const apiKey = env.HIGHLEVEL_API_KEY;
  const locationId = env.HIGHLEVEL_LOCATION_ID;
  if (!apiKey || !locationId) {
    console.error('✗ HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID missing from .env.local');
    process.exit(1);
  }
  console.log(`locationId: ${locationId}`);
  console.log(`apiKey: present (${apiKey.length} chars, not printed)`);

  // ── (a) GET /conversations/search ────────────────────────────────────────
  hr('(a) GET /conversations/search  — does the API list conversations?');
  const searchPath = `/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=5`;
  console.log(`request: GET ${searchPath}  (Version: ${CONVERSATIONS_API_VERSION})`);
  const search = await ghlGet(searchPath, apiKey);
  console.log(`status: ${search.status}`);
  if (search.status !== 200) {
    console.error('✗ non-200 — likely a missing conversations.* scope on the PIT, or wrong Version.');
    console.error('raw body (first 800 chars):');
    console.error(search.text.slice(0, 800));
    console.error('\n→ Action: confirm the Private Integration token includes conversations.readonly /');
    console.error('  conversations/message.readonly scopes (scopes are immutable — recreate the PIT if not).');
    process.exit(1);
  }
  console.log('top-level keys:', Object.keys(search.json as object));
  const conv = firstArray(search.json);
  if (!conv || conv.rows.length === 0) {
    console.log('⚠ 0 conversations returned. Cannot inspect a sample row or fetch messages.');
    console.log('  (If the location truly has conversations, the search filter/params may need tuning.)');
    process.exit(0);
  }
  console.log(`conversations array at: "${conv.key}"  (count in page: ${conv.rows.length})`);
  hr('   conversation[0] — FIELD NAMES + TYPES (the plan-critical part)');
  console.log(JSON.stringify(shapeOf(conv.rows[0]), null, 2));
  hr('   conversation[0] — SAMPLE ROW (PII masked)');
  console.log(JSON.stringify(maskRow(conv.rows[0]), null, 2));

  // Surface the exact fields the plan keys "unresponded" detection off of.
  const c0 = conv.rows[0] as Record<string, unknown>;
  hr('   plan-assumption check — fields used for "unresponded" detection');
  for (const want of ['unreadCount', 'lastMessageBody', 'lastMessageDirection', 'lastMessageDate', 'lastMessageType', 'contactId', 'id', 'type']) {
    const present = Object.prototype.hasOwnProperty.call(c0, want);
    console.log(`  ${present ? '✓' : '✗ MISSING'}  ${want}${present ? ` = ${JSON.stringify(maskRow(c0)[want])}` : ''}`);
  }

  // ── (b) GET /conversations/{id}/messages ─────────────────────────────────
  const convId = String(c0.id ?? '');
  hr(`(b) GET /conversations/${convId}/messages  — message direction/status fields?`);
  const msgPath = `/conversations/${encodeURIComponent(convId)}/messages`;
  console.log(`request: GET ${msgPath}  (Version: ${CONVERSATIONS_API_VERSION})`);
  const msgs = await ghlGet(msgPath, apiKey);
  console.log(`status: ${msgs.status}`);
  if (msgs.status !== 200) {
    console.error('✗ non-200 fetching messages. raw body (first 800):');
    console.error(msgs.text.slice(0, 800));
  } else {
    console.log('top-level keys:', Object.keys(msgs.json as object));
    const m = firstArray(msgs.json);
    if (!m || m.rows.length === 0) {
      console.log('⚠ 0 messages returned for this conversation.');
    } else {
      console.log(`messages array at: "${m.key}"  (count: ${m.rows.length})`);
      hr('   message[0] — FIELD NAMES + TYPES');
      console.log(JSON.stringify(shapeOf(m.rows[0]), null, 2));
      hr('   each message — direction / status / type / dateAdded (masked)');
      for (const row of m.rows.slice(0, 10)) {
        const r = row as Record<string, unknown>;
        console.log(
          JSON.stringify({
            id: r.id,
            direction: r.direction,
            status: r.status,
            type: r.type,
            messageType: r.messageType,
            dateAdded: r.dateAdded,
            body: truncate(r.body, 40),
          }),
        );
      }
    }
  }

  // ── mark-read: DOCUMENTED ONLY, never executed ───────────────────────────
  hr('mark-read — DOCUMENTED, NOT EXECUTED (needs human go-ahead)');
  console.log(`The "Handled" write-back would mark the conversation read with:

    PUT ${API_BASE}/conversations/${convId}/messages/{messageId}/status
    headers: Authorization: Bearer <PIT>, Version: ${CONVERSATIONS_API_VERSION}, Content-Type: application/json
    body:    { "status": "read" }

  OPEN QUESTION the spike CANNOT answer without mutating GHL: does marking the
  last inbound MESSAGE read also clear the CONVERSATION-level unread badge
  (unreadCount → 0)? If not, the reconcile cron will re-surface a handled card.
  Resolve by either (1) a one-off manual test on a throwaway conversation with a
  human watching, or (2) GHL docs/support. STOPPING here — no PUT is sent.`);
}

main().catch((err) => {
  console.error('spike failed:', err);
  process.exit(1);
});
