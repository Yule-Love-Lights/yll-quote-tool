/**
 * winback-send.ts — daily send engine for the winback-2026 SMS campaign (S31).
 *
 * Jason-approved plan (2026-07-27): 40 texts/day, every day, until the untouched
 * pool is covered. Segment A (bid sent) first with the X/Y split test, then
 * Segment B with the free-design message. Copy approved verbatim by Jason.
 *
 * DRY-RUN BY DEFAULT — renders every message, sends nothing.
 *   npx tsx scripts/winback-send.ts            # dry-run preview of the next batch
 *   npx tsx scripts/winback-send.ts --live     # SEND the next batch (Jason's "send")
 *   npx tsx scripts/winback-send.ts --check    # re-read delivery statuses for sent msgs
 *   npx tsx scripts/winback-send.ts --batch 20 # override batch size (default 40, hard cap 50)
 *
 * Per-contact LIVE pre-send verify (every run, even dry): skip + log reason if
 *   - tag winback-2026 no longer on the contact (staff untagged them mid-campaign)
 *   - DND flagged (contact.dnd or dndSettings SMS active/permanent — they sent STOP)
 *   - already has an outbound SMS in the campaign window (never double-send)
 *   - has ANY inbound SMS in the window (they replied; humans take over)
 *   - opportunity stage/status moved since campaign start (active deal forming)
 *
 * State + logs live OUTSIDE the repo (customer PII):
 *   C:\Users\Jason\Documents\YLL-Winback\state.json      pool + per-contact status
 *   C:\Users\Jason\Documents\YLL-Winback\send-log.jsonl  append-only send log
 *   C:\Users\Jason\Documents\YLL-Winback\preview-*.txt   dry-run renders
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      process.env[m[1]] = val;
    }
  } catch { /* rely on ambient env */ }
}
loadEnvLocal();

const API_BASE = 'https://services.leadconnectorhq.com';
const CONTACTS_VERSION = '2021-07-28';
const CONVERSATIONS_VERSION = '2021-04-15';
const apiKey = process.env.HIGHLEVEL_API_KEY;
const locationId = process.env.HIGHLEVEL_LOCATION_ID;
const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
if (!apiKey || !locationId) throw new Error('HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set in .env.local');

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const CHECK = argv.includes('--check');
const REPLIES = argv.includes('--replies');
const batchArg = argv.indexOf('--batch');
const BATCH = Math.min(batchArg >= 0 ? Number(argv[batchArg + 1]) || 40 : 40, 50); // hard cap 50/day
const WINDOW_START = '2026-07-01';
// Naldo's one-time status backfill bulk-stamped lastStatusChangeAt on ~880 cards
// 2026-07-20 17:48–18:20 UTC (probed live). Opp "activity" only counts AFTER it,
// or every untouched prospect looks like an active deal and gets skipped.
const OPP_ACTIVITY_START = '2026-07-21';

// Campaign state/artifacts live OUTSIDE the repo (never commit state.json,
// send-log.jsonl or the previews). Defaults are Jason's machine — the env vars
// exist so this isn't hard-locked to one laptop. WINBACK_ARTIFACT points at the
// recon run's JSON output (see winback-recon.ts's --out).
const DIR = process.env.WINBACK_DIR ?? 'C:/Users/Jason/Documents/YLL-Winback';
const STATE_PATH = join(DIR, 'state.json');
const LOG_PATH = join(DIR, 'send-log.jsonl');
const ARTIFACT =
  process.env.WINBACK_ARTIFACT ??
  'C:/Users/Jason/AppData/Local/Temp/claude/C--Users-Jason-Desktop-YuleLoveLights-yll-quote-tool/34ff624b-7267-480d-8fe6-eabc52f0d184/scratchpad/winback-recon-2026-07-27.json';

// ── Approved copy (Jason, 2026-07-27 — do not edit without a fresh approval) ──
const TEMPLATES: Record<string, (name: string | null) => string> = {
  X: n => n
    ? `Hi ${n}, it's Yule Love Lights. We quoted your house for holiday lights before and we still have your design on file. Book before Nov 1 and take 10% off the whole job. Install, takedown and storage included. Want your updated price?`
    : `Hi, it's Yule Love Lights. We quoted your house for holiday lights before and we still have your design on file. Book before Nov 1 and take 10% off the whole job. Install, takedown and storage included. Want your updated price?`,
  Y: n => n
    ? `Hi ${n}, Yule Love Lights here. Thinking about holiday lights this year? We quoted you before, so I can get your 2026 price fast. Reply YES and I'll send it, with 10% off if you book before Nov 1.`
    : `Hi, Yule Love Lights here. Thinking about holiday lights this year? We quoted you before, so I can get your 2026 price fast. Reply YES and I'll send it, with 10% off if you book before Nov 1.`,
  B: n => n
    ? `Hi ${n}, it's Yule Love Lights. You asked about holiday lights a while back. Want a free custom design for your house this year? Book before Nov 1 and take 10% off the whole job. Reply YES and we'll put one together.`
    : `Hi, it's Yule Love Lights. You asked about holiday lights a while back. Want a free custom design for your house this year? Book before Nov 1 and take 10% off the whole job. Reply YES and we'll put one together.`,
};

function titleCase(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// ── Paced GHL fetch ────────────────────────────────────────────────────────
let lastFetch = 0;
async function paced(url: string, init: RequestInit = {}, version = CONTACTS_VERSION, tries = 3): Promise<Response> {
  const wait = lastFetch + 140 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
  });
  if ((res.status === 429 || res.status >= 500) && tries > 1) {
    await new Promise(r => setTimeout(r, 2500));
    return paced(url, init, version, tries - 1);
  }
  return res;
}
async function pacedJson<T>(url: string, init: RequestInit = {}, version = CONTACTS_VERSION): Promise<T> {
  const res = await paced(url, init, version);
  if (!res.ok) throw new Error(`GHL ${init.method ?? 'GET'} ${url.replace(API_BASE, '')} -> ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// ── State ──────────────────────────────────────────────────────────────────
type PoolRow = {
  id: string; name: string; first: string; grp: 'X' | 'Y' | 'B'; segment: 'A' | 'B';
  // 'send-ambiguous' = the send POST errored AFTER dispatch was possible (5xx /
  // network). GHL may or may not have queued the SMS — NEVER auto-retry these
  // (double-text risk, S29 lesson); --check resolves them from the live thread.
  status: 'pending' | 'sent' | 'skipped' | 'send-ambiguous';
  sentAt?: string; messageId?: string; deliveryStatus?: string; skipReason?: string; renderedBody?: string;
};
type State = { createdAt: string; pool: PoolRow[] };

function buildPool(): State {
  const art = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { reports: { id: string; name: string; firstNameRaw: string; tags: string[]; outboundSms: unknown[] }[] };
  const untouched = art.reports.filter(r => r.outboundSms.length === 0 && !/delete/i.test(r.name));
  const segA = untouched.filter(r => r.tags.includes('bid sent')).sort((a, b) => a.id.localeCompare(b.id));
  const segB = untouched.filter(r => !r.tags.includes('bid sent')).sort((a, b) => a.id.localeCompare(b.id));
  const pool: PoolRow[] = [
    ...segA.map((r, i) => ({ id: r.id, name: r.name, first: r.firstNameRaw, grp: (i % 2 === 0 ? 'X' : 'Y') as 'X' | 'Y', segment: 'A' as const, status: 'pending' as const })),
    ...segB.map(r => ({ id: r.id, name: r.name, first: r.firstNameRaw, grp: 'B' as const, segment: 'B' as const, status: 'pending' as const })),
  ];
  return { createdAt: new Date().toISOString(), pool };
}
function loadState(): State {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  const s = buildPool();
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  console.log(`[state] new pool built: ${s.pool.length} pending (A=${s.pool.filter(p => p.segment === 'A').length}, B=${s.pool.filter(p => p.segment === 'B').length}) -> ${STATE_PATH}`);
  return s;
}
const saveState = (s: State) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
const log = (o: Record<string, unknown>) => appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

// ── Live pre-send verify ───────────────────────────────────────────────────
type Verify = { ok: true } | { ok: false; reason: string };
async function verifyContact(id: string): Promise<Verify> {
  const cj = await pacedJson<{ contact?: { tags?: string[]; dnd?: boolean; dndSettings?: Record<string, { status?: string }> } }>(`${API_BASE}/contacts/${id}`);
  const c = cj.contact ?? {};
  if (!(c.tags ?? []).includes('winback-2026')) return { ok: false, reason: 'tag-removed' };
  if (c.dnd === true) return { ok: false, reason: 'dnd-contact' };
  const smsDnd = c.dndSettings?.SMS?.status ?? '';
  if (/^(active|permanent)$/i.test(smsDnd)) return { ok: false, reason: `dnd-sms-${smsDnd}` };

  const convs = await pacedJson<{ conversations?: { id: string; lastMessageDate?: string }[] }>(
    `${API_BASE}/conversations/search?${new URLSearchParams({ locationId: locationId!, contactId: id, limit: '20' })}`, {}, CONVERSATIONS_VERSION);
  for (const conv of convs.conversations ?? []) {
    if (conv.lastMessageDate && conv.lastMessageDate < WINDOW_START) continue;
    const mj = await pacedJson<{ messages?: { messages?: { direction?: string; messageType?: string; dateAdded?: string }[] } }>(
      `${API_BASE}/conversations/${conv.id}/messages?limit=100`, {}, CONVERSATIONS_VERSION);
    for (const m of mj.messages?.messages ?? []) {
      if (!m.dateAdded || m.dateAdded < WINDOW_START) continue;
      const sms = (m.messageType ?? '').toUpperCase().includes('SMS');
      if (sms && m.direction === 'outbound') return { ok: false, reason: 'already-texted' };
      if (sms && m.direction === 'inbound') return { ok: false, reason: 'replied' };
    }
  }

  const oj = await pacedJson<{ opportunities?: { lastStageChangeAt?: string; lastStatusChangeAt?: string }[] }>(
    `${API_BASE}/opportunities/search?${new URLSearchParams({ location_id: locationId!, contact_id: id })}`);
  for (const o of oj.opportunities ?? []) {
    const moved = [o.lastStageChangeAt, o.lastStatusChangeAt].filter(Boolean).sort().pop();
    if (moved && moved >= OPP_ACTIVITY_START) return { ok: false, reason: 'opp-active-movement' };
  }
  return { ok: true };
}

// ── Modes ──────────────────────────────────────────────────────────────────
async function runCheck(state: State): Promise<void> {
  const sent = state.pool.filter(p => (p.status === 'sent' && p.deliveryStatus !== 'delivered') || p.status === 'send-ambiguous');
  console.log(`[check] re-reading delivery for ${sent.length} non-confirmed sends…`);
  for (const p of sent) {
    try {
      const convs = await pacedJson<{ conversations?: { id: string }[] }>(
        `${API_BASE}/conversations/search?${new URLSearchParams({ locationId: locationId!, contactId: p.id, limit: '5' })}`, {}, CONVERSATIONS_VERSION);
      let hit: { id?: string; status?: string; body?: string } | undefined;
      for (const conv of convs.conversations ?? []) {
        const mj = await pacedJson<{ messages?: { messages?: { id?: string; status?: string; body?: string; direction?: string }[] } }>(
          `${API_BASE}/conversations/${conv.id}/messages?limit=20`, {}, CONVERSATIONS_VERSION);
        const msgs = mj.messages?.messages ?? [];
        // sent rows match by messageId; ambiguous rows (no id) match the exact rendered body
        hit = msgs.find(m => (p.messageId && m.id === p.messageId) || (!p.messageId && m.direction === 'outbound' && (m.body ?? '').trim() === (p.renderedBody ?? '').trim()));
        if (hit) break;
      }
      if (hit) {
        if (p.status === 'send-ambiguous') { p.status = 'sent'; p.messageId = p.messageId ?? hit.id; log({ event: 'ambiguous-resolved-sent', id: p.id, name: p.name }); }
        p.deliveryStatus = hit.status ?? p.deliveryStatus;
      } else if (p.status === 'send-ambiguous') {
        // Not in the thread -> the send never landed. Stays parked; flip to
        // 'pending' by hand after an eyeball (never auto-requeue a maybe-sent).
        p.deliveryStatus = 'not-found-in-thread';
        log({ event: 'ambiguous-not-found', id: p.id, name: p.name });
      }
      console.log(`  ${p.name}: ${p.status} / ${p.deliveryStatus ?? '(unknown)'}`);
    } catch (e) { console.log(`  ${p.name}: check failed — ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
  }
  saveState(state);
  const counts: Record<string, number> = {};
  for (const p of state.pool.filter(x => x.status === 'sent')) counts[p.deliveryStatus ?? '(unknown)'] = (counts[p.deliveryStatus ?? '(unknown)'] ?? 0) + 1;
  console.log(`[check] delivery totals: ${JSON.stringify(counts)}`);
}

// --replies: scan every sent contact's thread for inbound SMS after their send.
// Read-only. Prints verbatim reply text + current DND so a human can respond.
async function runReplies(state: State): Promise<void> {
  const sent = state.pool.filter(p => p.status === 'sent');
  console.log(`[replies] scanning ${sent.length} sent contacts for inbound SMS…`);
  let found = 0;
  for (const p of sent) {
    try {
      const convs = await pacedJson<{ conversations?: { id: string; lastMessageDate?: string }[] }>(
        `${API_BASE}/conversations/search?${new URLSearchParams({ locationId: locationId!, contactId: p.id, limit: '5' })}`, {}, CONVERSATIONS_VERSION);
      for (const conv of convs.conversations ?? []) {
        if (conv.lastMessageDate && p.sentAt && conv.lastMessageDate < p.sentAt) continue;
        const mj = await pacedJson<{ messages?: { messages?: { direction?: string; messageType?: string; dateAdded?: string; body?: string }[] } }>(
          `${API_BASE}/conversations/${conv.id}/messages?limit=30`, {}, CONVERSATIONS_VERSION);
        for (const m of mj.messages?.messages ?? []) {
          if (m.direction !== 'inbound' || !(m.messageType ?? '').toUpperCase().includes('SMS')) continue;
          if (!m.dateAdded || !p.sentAt || m.dateAdded < p.sentAt) continue;
          found++;
          const cj = await pacedJson<{ contact?: { dndSettings?: Record<string, { status?: string }> } }>(`${API_BASE}/contacts/${p.id}`);
          const dndNow = cj.contact?.dndSettings?.SMS?.status ?? 'none';
          console.log(`  💬 [${p.grp}] ${p.name} (${m.dateAdded}) dnd=${dndNow}: ${(m.body ?? '').trim()}`);
          log({ event: 'reply-seen', id: p.id, name: p.name, grp: p.grp, at: m.dateAdded, body: (m.body ?? '').trim(), dnd: dndNow });
        }
      }
    } catch (e) { console.log(`  ${p.name}: reply scan failed — ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
  }
  console.log(`[replies] ${found} inbound message(s) found.`);
}

async function main() {
  const state = loadState();
  if (CHECK) return runCheck(state);
  if (REPLIES) return runReplies(state);

  const already = state.pool.filter(p => p.status === 'sent').length;
  console.log(`${LIVE ? '🔴 LIVE SEND' : 'DRY RUN (nothing sends)'} — batch cap ${BATCH}; pool: ${state.pool.filter(p => p.status === 'pending').length} pending / ${already} sent`);

  const batch: { row: PoolRow; body: string }[] = [];
  for (const row of state.pool) {
    if (batch.length >= BATCH) break;
    if (row.status !== 'pending') continue;
    const v = await verifyContact(row.id).catch((e): Verify => ({ ok: false, reason: `verify-error: ${e instanceof Error ? e.message.slice(0, 100) : e}` }));
    if (!v.ok) {
      // verify-errors stay pending (retry next run); real disqualifiers are recorded
      if (!v.reason.startsWith('verify-error')) { row.status = 'skipped'; row.skipReason = v.reason; log({ event: 'skip', id: row.id, name: row.name, reason: v.reason }); }
      console.log(`  SKIP ${row.name}: ${v.reason}`);
      continue;
    }
    batch.push({ row, body: TEMPLATES[row.grp](titleCase(row.first)) });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const preview = batch.map(b => `[${b.row.grp}] ${b.row.name} (${b.row.id})\n  ${b.body}`).join('\n\n');
  const previewPath = join(DIR, `preview-${stamp}.txt`);
  writeFileSync(previewPath, preview);
  console.log(`\nBatch of ${batch.length}: X=${batch.filter(b => b.row.grp === 'X').length} Y=${batch.filter(b => b.row.grp === 'Y').length} B=${batch.filter(b => b.row.grp === 'B').length}`);
  console.log(`Rendered preview -> ${previewPath}`);

  if (!LIVE) {
    console.log('\nDry run complete. Run with --live to send this exact batch.');
    saveState(state); // persist any skips discovered
    return;
  }

  console.log('\nSending…');
  let ok = 0, failed = 0;
  for (const { row, body } of batch) {
    try {
      // tries=1: NEVER auto-retry a send POST — a 5xx after GHL queued the SMS
      // would double-text the customer. Ambiguous outcomes park as 'send-ambiguous'.
      const sendRes = await paced(
        `${API_BASE}/conversations/messages`,
        { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: row.id, message: body, ...(fromNumber ? { fromNumber } : {}) }) },
        CONVERSATIONS_VERSION,
        1,
      );
      if (!sendRes.ok) {
        const errBody = (await sendRes.text().catch(() => '')).slice(0, 200);
        // 4xx = GHL rejected it, nothing dispatched -> safe to leave pending.
        // 5xx = unknown dispatch state -> park, never retry.
        if (sendRes.status >= 500) {
          row.status = 'send-ambiguous'; row.sentAt = new Date().toISOString(); row.renderedBody = body;
          log({ event: 'send-ambiguous', id: row.id, name: row.name, grp: row.grp, httpStatus: sendRes.status, error: errBody });
          failed++;
          console.log(`  ? [${row.grp}] ${row.name}: ${sendRes.status} AMBIGUOUS — parked, resolve via --check`);
        } else {
          failed++;
          log({ event: 'send-failed', id: row.id, name: row.name, grp: row.grp, httpStatus: sendRes.status, error: errBody });
          console.log(`  ✗ [${row.grp}] ${row.name}: ${sendRes.status} ${errBody}`);
        }
        saveState(state);
        continue;
      }
      const res = await sendRes.json() as { messageId?: string; conversationId?: string };
      row.status = 'sent'; row.sentAt = new Date().toISOString(); row.messageId = res.messageId; row.renderedBody = body;
      log({ event: 'sent', id: row.id, name: row.name, grp: row.grp, messageId: res.messageId, body });
      ok++;
      console.log(`  ✓ [${row.grp}] ${row.name}`);
      saveState(state); // persist after EVERY send — a crash mid-batch must never cause a double-send
      await new Promise(r => setTimeout(r, 1400));
    } catch (e) {
      // Network-level throw: the request MAY have reached GHL. Park, never retry.
      failed++;
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      row.status = 'send-ambiguous'; row.sentAt = new Date().toISOString(); row.renderedBody = body;
      log({ event: 'send-ambiguous', id: row.id, name: row.name, grp: row.grp, error: msg });
      console.log(`  ? [${row.grp}] ${row.name}: AMBIGUOUS (${msg}) — parked, resolve via --check`);
      saveState(state);
    }
  }
  console.log(`\nDone: ${ok} sent, ${failed} failed. Run --check in ~15 min for delivery statuses.`);
  console.log(`Log: ${LOG_PATH}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
