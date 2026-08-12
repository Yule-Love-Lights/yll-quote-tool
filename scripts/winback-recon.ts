/**
 * winback-recon.ts — READ-ONLY recon of the "winback-2026" SMS campaign (S31).
 *
 * Rebuilds the campaign scoreboard from the LIVE GHL account instead of
 * trusting the handoff summary (task-text-is-hypothesis rule):
 *   - contacts carrying the tag (+ full tag distribution → finds segment tags)
 *   - who has received a campaign SMS (outbound SMS since --since), per-day
 *   - the distinct outbound SMS bodies (recovers the actual sent copy)
 *   - REPLIES: inbound SMS after the contact's first campaign SMS, verbatim
 *   - opt-outs: DND flags + STOP-shaped inbound bodies
 *   - opportunity cards: status + any movement after the first text
 *   - email double-touch: outbound emails in the window (permanent campaign)
 *
 * ZERO writes. Only GET endpoints + POST /contacts/search (a search, not a write).
 *
 * Usage:
 *   npx tsx scripts/winback-recon.ts                 # full recon
 *   npx tsx scripts/winback-recon.ts --limit 5       # shape probe on 5 contacts
 *   npx tsx scripts/winback-recon.ts --tag other-tag --since 2026-07-01
 *
 * Output: console scoreboard + full JSON artifact written OUTSIDE the repo
 * (scratchpad) so customer PII never lands in git.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Minimal .env.local loader (same pattern as match-legacy-contacts.ts) ──
function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}

// ── Config / args ──────────────────────────────────────────────────────────
loadEnvLocal();
const API_BASE = 'https://services.leadconnectorhq.com';
const CONTACTS_VERSION = '2021-07-28';
const CONVERSATIONS_VERSION = '2021-04-15';
const apiKey = process.env.HIGHLEVEL_API_KEY;
const locationId = process.env.HIGHLEVEL_LOCATION_ID;
if (!apiKey || !locationId) throw new Error('HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set in .env.local');

const argv = process.argv.slice(2);
function argOf(flag: string, dflt: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const TAG = argOf('--tag', 'winback-2026');
const SINCE = new Date(argOf('--since', '2026-07-01T00:00:00-04:00'));
const LIMIT = Number(argOf('--limit', '0')) || 0; // 0 = all
const OUT_DIR = argOf(
  '--out',
  'C:/Users/Jason/AppData/Local/Temp/claude/C--Users-Jason-Desktop-YuleLoveLights-yll-quote-tool/34ff624b-7267-480d-8fe6-eabc52f0d184/scratchpad',
);

// ── Paced fetch: stay far under GHL's 100-req/10s burst limit ─────────────
let lastFetch = 0;
const GAP_MS = 130; // ~7.7 req/s
async function pacedFetch(url: string, init: RequestInit, version: string, tries = 3): Promise<Response> {
  const wait = lastFetch + GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: version,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 429 && tries > 1) {
    await new Promise(r => setTimeout(r, 2500));
    return pacedFetch(url, init, version, tries - 1);
  }
  return res;
}

async function ghlJson<T>(path: string, init: RequestInit = {}, version = CONTACTS_VERSION): Promise<T> {
  const res = await pacedFetch(`${API_BASE}${path}`, init, version);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL ${init.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ── Types (loose — we log unknown shapes rather than assume) ──────────────
type Contact = {
  id: string;
  firstName?: string; lastName?: string; contactName?: string;
  email?: string; phone?: string;
  tags?: string[];
  dnd?: boolean;
  dndSettings?: Record<string, { status?: string; message?: string }>;
  dateAdded?: string;
  searchAfter?: unknown[];
};
type Conversation = { id: string; contactId?: string; lastMessageDate?: string; lastMessageDirection?: string; type?: string | number; unreadCount?: number };
type Message = {
  id?: string; direction?: string; status?: string; body?: string;
  dateAdded?: string; messageType?: string; type?: number; contentType?: string;
};
type Opp = {
  id: string; name?: string; status?: string; pipelineId?: string; pipelineStageId?: string;
  monetaryValue?: number; createdAt?: string; updatedAt?: string;
  lastStatusChangeAt?: string; lastStageChangeAt?: string;
};

// ── Step 1: contacts by tag (POST /contacts/search, searchAfter paging) ───
async function contactsByTag(tag: string): Promise<Contact[]> {
  const out: Contact[] = [];
  let searchAfter: unknown[] | undefined;
  for (let page = 0; page < 50; page++) {
    const body: Record<string, unknown> = {
      locationId,
      pageLimit: 100,
      filters: [{ field: 'tags', operator: 'eq', value: tag }],
      ...(searchAfter ? { searchAfter } : {}),
    };
    const json = await ghlJson<{ contacts?: Contact[]; total?: number }>(
      '/contacts/search',
      { method: 'POST', body: JSON.stringify(body) },
    );
    const batch = json.contacts ?? [];
    if (page === 0) console.log(`  [shape] /contacts/search total=${json.total} firstKeys=${batch[0] ? Object.keys(batch[0]).slice(0, 20).join(',') : 'EMPTY'}`);
    out.push(...batch);
    if (batch.length < 100) break;
    searchAfter = batch[batch.length - 1]?.searchAfter;
    if (!searchAfter) { console.log('  [warn] no searchAfter cursor on last row; stopping pagination'); break; }
  }
  return out;
}

// ── Step 2: per-contact conversations → messages ──────────────────────────
async function conversationsFor(contactId: string): Promise<Conversation[]> {
  const params = new URLSearchParams({ locationId: locationId!, contactId, limit: '20' });
  const json = await ghlJson<{ conversations?: Conversation[] }>(
    `/conversations/search?${params}`, {}, CONVERSATIONS_VERSION,
  );
  return json.conversations ?? [];
}
async function messagesFor(conversationId: string): Promise<Message[]> {
  const json = await ghlJson<{ messages?: { messages?: Message[] } }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`, {}, CONVERSATIONS_VERSION,
  );
  return json.messages?.messages ?? [];
}
async function oppsFor(contactId: string): Promise<Opp[]> {
  // NO pipeline filter — we want cards from ALL pipelines.
  const params = new URLSearchParams({ location_id: locationId!, contact_id: contactId });
  const json = await ghlJson<{ opportunities?: Opp[] }>(`/opportunities/search?${params}`);
  return json.opportunities ?? [];
}

// ── Classification helpers ────────────────────────────────────────────────
const isSms = (m: Message) => (m.messageType ?? '').toUpperCase().includes('SMS') || m.type === 1 || m.type === 2;
const isEmail = (m: Message) => (m.messageType ?? '').toUpperCase().includes('EMAIL') || m.type === 3;
const when = (m: Message) => (m.dateAdded ? new Date(m.dateAdded) : null);
const inWindow = (m: Message) => { const d = when(m); return d != null && d >= SINCE; };
const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove me)\b/i;
const nameOf = (c: Contact) => c.contactName ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)');

interface ContactReport {
  id: string; name: string; firstNameRaw: string; phoneLast4: string; email: string;
  tags: string[]; dnd: boolean; dndSms: string;
  outboundSms: { date: string; status: string; body: string }[];
  inboundSms: { date: string; body: string }[];
  outboundEmails: number;
  repliedAfterCampaign: boolean;
  stopShaped: boolean;
  opps: { id: string; name: string; status: string; pipelineId: string; stageId: string; updatedAt: string; lastStageChangeAt: string; lastStatusChangeAt: string; monetaryValue: number | null }[];
  oppMovedAfterFirstText: boolean;
  error?: string;
}

async function main() {
  console.log(`Winback recon — tag "${TAG}", window since ${SINCE.toISOString()}, location ${locationId}`);
  console.log('READ-ONLY: no writes of any kind.\n');

  console.log('Step 1: contacts by tag…');
  let contacts = await contactsByTag(TAG);
  console.log(`  -> ${contacts.length} contacts carry "${TAG}"`);
  if (LIMIT > 0) { contacts = contacts.slice(0, LIMIT); console.log(`  (--limit ${LIMIT}: probing first ${contacts.length} only)`); }

  const seenTypePairs = new Set<string>();
  const reports: ContactReport[] = [];
  let done = 0;

  for (const c of contacts) {
    const rep: ContactReport = {
      id: c.id, name: nameOf(c), firstNameRaw: c.firstName ?? '',
      phoneLast4: (c.phone ?? '').replace(/\D/g, '').slice(-4), email: c.email ?? '',
      tags: c.tags ?? [], dnd: c.dnd === true,
      dndSms: c.dndSettings?.SMS?.status ?? c.dndSettings?.sms?.status ?? '',
      outboundSms: [], inboundSms: [], outboundEmails: 0,
      repliedAfterCampaign: false, stopShaped: false,
      opps: [], oppMovedAfterFirstText: false,
    };
    try {
      const convs = await conversationsFor(c.id);
      for (const conv of convs) {
        // skip conversations with zero chance of window activity
        if (conv.lastMessageDate && new Date(conv.lastMessageDate) < SINCE) continue;
        const msgs = await messagesFor(conv.id);
        for (const m of msgs) {
          seenTypePairs.add(`${m.type}/${m.messageType}/${m.direction}`);
          if (!inWindow(m)) continue;
          const d = when(m)!.toISOString();
          if (isSms(m) && m.direction === 'outbound') rep.outboundSms.push({ date: d, status: m.status ?? '', body: (m.body ?? '').trim() });
          else if (isSms(m) && m.direction === 'inbound') rep.inboundSms.push({ date: d, body: (m.body ?? '').trim() });
          // Probe finding: TYPE_EMAIL messages arrive with direction UNDEFINED, so
          // count any in-window email touch (inbound customer emails are rare here;
          // the artifact keeps the raw messages if we ever need to split them).
          else if (isEmail(m) && m.direction !== 'inbound') rep.outboundEmails++;
        }
      }
      rep.outboundSms.sort((a, b) => a.date.localeCompare(b.date));
      rep.inboundSms.sort((a, b) => a.date.localeCompare(b.date));
      const firstOut = rep.outboundSms[0]?.date;
      if (firstOut) {
        rep.repliedAfterCampaign = rep.inboundSms.some(i => i.date >= firstOut);
      }
      rep.stopShaped = rep.inboundSms.some(i => STOP_RE.test(i.body));

      const opps = await oppsFor(c.id);
      rep.opps = opps.map(o => ({
        id: o.id, name: o.name ?? '', status: o.status ?? '', pipelineId: o.pipelineId ?? '',
        stageId: o.pipelineStageId ?? '', updatedAt: o.updatedAt ?? '',
        lastStageChangeAt: o.lastStageChangeAt ?? '', lastStatusChangeAt: o.lastStatusChangeAt ?? '',
        monetaryValue: o.monetaryValue ?? null,
      }));
      if (firstOut) {
        rep.oppMovedAfterFirstText = rep.opps.some(o => {
          const moved = o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt;
          return moved !== '' && moved >= firstOut;
        });
      }
    } catch (e) {
      rep.error = e instanceof Error ? e.message : String(e);
    }
    reports.push(rep);
    done++;
    if (done % 25 === 0) console.log(`  …${done}/${contacts.length}`);
  }

  // ── Aggregate ───────────────────────────────────────────────────────────
  const touched = reports.filter(r => r.outboundSms.length > 0);
  const untouched = reports.filter(r => r.outboundSms.length === 0 && !r.error);
  const errored = reports.filter(r => r.error);
  const replied = reports.filter(r => r.repliedAfterCampaign);
  const stopShaped = reports.filter(r => r.stopShaped);
  // GHL's auto-opt-out sets dndSettings.SMS.status = "permanent" (STOP_KEYWORD);
  // the contact-search payload omits dndSettings, so a full GET /contacts/{id} is
  // needed to see it (learned live off a real DND-permanent contact, 2026-07-27).
  const dndFlagged = reports.filter(r => r.dnd || /^(active|permanent)$/i.test(r.dndSms));
  const doubleTouched = reports.filter(r => r.outboundSms.length > 0 && r.outboundEmails > 0);
  const emailedInWindow = reports.filter(r => r.outboundEmails > 0);
  const oppMoved = reports.filter(r => r.oppMovedAfterFirstText);
  const won = reports.filter(r => r.opps.some(o => o.status === 'won'));

  // delivery statuses
  const statusCounts: Record<string, number> = {};
  const dayCounts: Record<string, number> = {};
  const templateCounts = new Map<string, number>();
  for (const r of touched) for (const s of r.outboundSms) {
    statusCounts[s.status || '(none)'] = (statusCounts[s.status || '(none)'] ?? 0) + 1;
    const day = s.date.slice(0, 10);
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    // template recovery: normalize the first-name slot crudely by first word after greeting
    const norm = s.body.replace(/\b[A-Z][a-z]+\b/g, '·').slice(0, 160);
    templateCounts.set(norm, (templateCounts.get(norm) ?? 0) + 1);
  }

  // tag distribution (find segment tags)
  const tagCounts: Record<string, number> = {};
  for (const r of reports) for (const t of r.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;

  console.log('\n════════ SCOREBOARD ════════');
  console.log(`tagged "${TAG}":            ${reports.length}`);
  console.log(`texted (≥1 outbound SMS):   ${touched.length}  (total msgs ${touched.reduce((n, r) => n + r.outboundSms.length, 0)})`);
  console.log(`delivery statuses:          ${JSON.stringify(statusCounts)}`);
  console.log(`per-day sends:              ${JSON.stringify(dayCounts)}`);
  console.log(`REPLIED after campaign:     ${replied.length}`);
  console.log(`STOP-shaped inbound:        ${stopShaped.length}`);
  console.log(`DND flagged (contact.dnd):  ${dndFlagged.length}`);
  console.log(`emailed in window:          ${emailedInWindow.length}  (SMS+email double-touched: ${doubleTouched.length})`);
  console.log(`opp moved after first text: ${oppMoved.length}`);
  console.log(`opp status=won (any time):  ${won.length}`);
  console.log(`untouched (no SMS yet):     ${untouched.length}`);
  console.log(`errored contacts:           ${errored.length}`);

  console.log('\n── tag distribution (top 15) ──');
  Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));

  console.log('\n── outbound SMS templates recovered (name-normalized, top 6) ──');
  Array.from(templateCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([t, n]) => console.log(`  ×${n}: ${t}`));

  if (replied.length) {
    console.log('\n── REPLIES (verbatim) ──');
    for (const r of replied) {
      console.log(`  ${r.name} (…${r.phoneLast4}):`);
      for (const i of r.inboundSms) console.log(`    [${i.date}] ${i.body}`);
    }
  }
  if (stopShaped.length) {
    console.log('\n── STOP-shaped ──');
    for (const r of stopShaped) console.log(`  ${r.name}: ${r.inboundSms.filter(i => STOP_RE.test(i.body)).map(i => i.body).join(' | ')}`);
  }
  if (errored.length) {
    console.log('\n── errors ──');
    for (const r of errored.slice(0, 10)) console.log(`  ${r.name}: ${r.error?.slice(0, 160)}`);
  }
  console.log(`\n[diag] message type/direction pairs seen: ${Array.from(seenTypePairs).join(' · ')}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const artifact = join(OUT_DIR, `winback-recon-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(artifact, JSON.stringify({ tag: TAG, since: SINCE.toISOString(), generatedAt: new Date().toISOString(), reports }, null, 2));
  console.log(`\nFull artifact (PII — stays local): ${artifact}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
