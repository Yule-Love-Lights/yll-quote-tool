/* scripts/match-legacy-contacts.ts — match the batch-2 legacy rebook drafts to
 * their EXISTING HighLevel contacts, so the send wave has a target
 * (send/route.ts hard-blocks a non-test send when quotes.highlevel_contact_id
 * is null → code:'no-contact'). Mirrors the one-off S40 pass that linked the
 * 114 batch-1 drafts.
 *
 * Usage:
 *   npx tsx scripts/match-legacy-contacts.ts                 # DRY-RUN (default) — reports only
 *   npx tsx scripts/match-legacy-contacts.ts --manifest scripts/legacy-migration-data/manifest-batch2.csv
 *   npx tsx scripts/match-legacy-contacts.ts --live         # (guarded — refuses until wired)
 *
 * READ-ONLY by default: it only calls GHL contact SEARCH (GET /contacts/) and
 * prints a match/ambiguous/none breakdown. It NEVER creates a contact (we never
 * auto-create — see send/route.ts) and NEVER writes to Supabase in dry-run.
 *
 * Matching: exact email (case-insensitive) is the primary signal; last-10
 * phone digits is the fallback. >1 distinct contact on the strong signal =
 * AMBIGUOUS (hand-resolve). 0 = NONE (no contact to link).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Minimal .env.local loader (same pattern as migrate-legacy-quotes.ts) ──
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

// ── Minimal RFC-4180 CSV parser (handles quoted fields w/ embedded commas) ──
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// ── GHL contact search (GET /contacts/ — the exact call searchContacts() makes) ──
const API_BASE = 'https://services.leadconnectorhq.com';
type GhlContact = { id: string; email?: string; phone?: string; contactName?: string; firstName?: string; lastName?: string };

async function ghlSearch(query: string): Promise<GhlContact[]> {
  const apiKey = process.env.HIGHLEVEL_API_KEY;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!apiKey || !locationId) throw new Error('HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set in .env.local');
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ locationId, query: q, limit: '20' });
  const res = await fetch(`${API_BASE}/contacts/?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GHL search "${q}" → ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = (await res.json()) as { contacts?: GhlContact[] };
  return json.contacts ?? [];
}

const digits10 = (s: string) => s.replace(/\D/g, '').slice(-10);
const nameOf = (c: GhlContact) => c.contactName ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)');
const uniqById = (cs: GhlContact[]) => Array.from(new Map(cs.map(c => [c.id, c])).values());

type Verdict = 'MATCH' | 'AMBIGUOUS' | 'NONE' | 'ERROR';
interface Result {
  name: string; email: string; phone: string; quoteId: string;
  verdict: Verdict; via: 'email' | 'phone' | ''; contactId: string; contactLabel: string; note: string;
}

async function classify(name: string, email: string, phone: string): Promise<Omit<Result, 'name' | 'email' | 'phone' | 'quoteId'>> {
  try {
    const wantPhone = digits10(phone);
    const wantEmail = email.trim().toLowerCase();

    // Primary: exact email.
    if (wantEmail) {
      const byEmail = uniqById(await ghlSearch(email)).filter(c => (c.email ?? '').trim().toLowerCase() === wantEmail);
      if (byEmail.length === 1) return { verdict: 'MATCH', via: 'email', contactId: byEmail[0].id, contactLabel: nameOf(byEmail[0]), note: '' };
      if (byEmail.length > 1) return { verdict: 'AMBIGUOUS', via: 'email', contactId: '', contactLabel: '', note: `${byEmail.length} contacts share this email: ${byEmail.map(c => c.id).join(', ')}` };
    }
    // Fallback: exact last-10 phone.
    if (wantPhone.length === 10) {
      const byPhone = uniqById(await ghlSearch(wantPhone)).filter(c => digits10(c.phone ?? '') === wantPhone);
      if (byPhone.length === 1) return { verdict: 'MATCH', via: 'phone', contactId: byPhone[0].id, contactLabel: nameOf(byPhone[0]), note: wantEmail ? 'no email match; matched on phone' : 'phone-only row' };
      if (byPhone.length > 1) return { verdict: 'AMBIGUOUS', via: 'phone', contactId: '', contactLabel: '', note: `${byPhone.length} contacts share this phone: ${byPhone.map(c => c.id).join(', ')}` };
    }
    return { verdict: 'NONE', via: '', contactId: '', contactLabel: '', note: wantEmail || wantPhone ? 'no exact email/phone match in GHL' : 'row has no email or phone' };
  } catch (e) {
    return { verdict: 'ERROR', via: '', contactId: '', contactLabel: '', note: (e as Error).message };
  }
}

async function main() {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const mi = args.indexOf('--manifest');
  const manifestPath = mi >= 0 ? args[mi + 1] : 'scripts/legacy-migration-data/manifest-batch2.csv';
  const stmt = resolve(process.cwd(), manifestPath);
  if (!existsSync(stmt)) throw new Error(`manifest not found: ${stmt}`);

  const rows = parseCsv(readFileSync(stmt, 'utf8')).filter(r => (r.include ?? '').toUpperCase() === 'Y');

  // Join quoteId from migration-state.json (key = "<roster#>|<street>") by street.
  const statePath = join(resolve(process.cwd(), manifestPath, '..'), 'migration-state.json');
  const state: Record<string, { quoteId?: string }> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const streetToQuote = new Map<string, string>();
  for (const [key, v] of Object.entries(state)) {
    const street = key.split('|').slice(1).join('|').trim();
    if (street && v?.quoteId) streetToQuote.set(street, v.quoteId);
  }

  console.log(`\nDRY-RUN — matching ${rows.length} batch-2 drafts to existing HighLevel contacts (no writes)\n`);
  const results: Result[] = [];
  for (const r of rows) {
    const name = r.client_name || '(no name)';
    const c = await classify(name, r.email || '', r.phone || '');
    results.push({ name, email: r.email || '', phone: r.phone || '', quoteId: streetToQuote.get((r.street || '').trim()) ?? '(unmatched street)', ...c });
    await new Promise(res => setTimeout(res, 120)); // gentle on the GHL rate limit
  }

  const icon: Record<Verdict, string> = { MATCH: '✅', AMBIGUOUS: '⚠️ ', NONE: '❌', ERROR: '🔥' };
  for (const [i, r] of results.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${icon[r.verdict]} ${r.verdict.padEnd(9)} ${r.name.slice(0, 24).padEnd(24)} ${r.via ? '(' + r.via + ')' : ''}`);
    if (r.contactId) console.log(`        → ${r.contactLabel}  [${r.contactId}]  quote ${r.quoteId}`);
    if (r.note) console.log(`        · ${r.note}`);
  }

  const by = (v: Verdict) => results.filter(r => r.verdict === v).length;
  console.log(`\nSUMMARY  ✅ ${by('MATCH')} match   ⚠️  ${by('AMBIGUOUS')} ambiguous   ❌ ${by('NONE')} none   🔥 ${by('ERROR')} error   (of ${results.length})`);

  if (!live) {
    console.log('Nothing was written (dry-run). Re-run with --live to link the MATCH rows.\n');
    return;
  }

  // ── --live: link the MATCH rows. Guarded UPDATE — only fills a NULL
  //    highlevel_contact_id on the exact quoteId, so it can never clobber an
  //    already-linked row and is safe to re-run. No GHL write, no send. ──
  const linkable = results.filter(r => r.verdict === 'MATCH' && r.contactId && r.quoteId && !r.quoteId.startsWith('('));
  console.log(`\n--live — linking ${linkable.length} MATCH rows (UPDATE quotes.highlevel_contact_id WHERE id=<quote> AND highlevel_contact_id IS NULL)\n`);
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env.local');
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key);

  let linked = 0, skipped = 0, failed = 0;
  for (const r of linkable) {
    const { data, error } = await sb
      .from('quotes')
      .update({ highlevel_contact_id: r.contactId })
      .eq('id', r.quoteId)
      .is('highlevel_contact_id', null)
      .select('id, highlevel_contact_id');
    if (error) { failed++; console.log(`🔥 FAIL   ${r.name.slice(0, 24).padEnd(24)} ${error.message}`); continue; }
    if (data && data.length === 1) { linked++; console.log(`✅ LINKED ${r.name.slice(0, 24).padEnd(24)} → ${r.contactId}  (quote ${r.quoteId})`); }
    else {
      // 0 rows updated → the row already had a contact (or the id vanished). Read back to report.
      const { data: cur } = await sb.from('quotes').select('highlevel_contact_id').eq('id', r.quoteId).maybeSingle();
      skipped++;
      console.log(`↷ SKIP   ${r.name.slice(0, 24).padEnd(24)} already linked to ${cur?.highlevel_contact_id ?? '(row not found)'}`);
    }
  }
  console.log(`\nWRITE SUMMARY  ✅ ${linked} linked   ↷ ${skipped} skipped(already-linked)   🔥 ${failed} failed   (of ${linkable.length})\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
