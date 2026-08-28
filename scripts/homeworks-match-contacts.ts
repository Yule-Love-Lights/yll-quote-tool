/* scripts/homeworks-match-contacts.ts — phase 2 of the Homeworks migration.
 *
 * The Homeworks export carries NO email or phone, only names and service
 * addresses. This resolves each of the 18 customers against GoHighLevel (our
 * customer database) to get their contact id, email and phone, so the quotes
 * can be matched and linked on a strong signal rather than on a name.
 *
 * Usage:
 *   npx tsx scripts/homeworks-match-contacts.ts
 *
 * READ-ONLY, unconditionally. There is no --live flag: this script only ever
 * calls GHL contact SEARCH (GET /contacts/) and reads quotes from Supabase. It
 * writes nothing, anywhere. Linking happens in a later phase, after Jason has
 * approved the identity table this prints.
 *
 * Matching: GHL is searched by full name. A single hit is a MATCH. Several hits
 * are AMBIGUOUS and get listed individually with their email, phone and address
 * so Jason can point at the right record — deliberately NOT auto-resolved by
 * address similarity, because two live incidents in this repo (ledger 251, 425)
 * came from a confident wrong customer link on an approved quote.
 *
 * Mirrors scripts/match-legacy-contacts.ts's env loader and search call.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
loadEnvLocal();

const API_BASE = 'https://services.leadconnectorhq.com';

type GhlContact = {
  id: string;
  email?: string;
  phone?: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  address1?: string;
  city?: string;
  postalCode?: string;
};

async function ghlSearch(query: string): Promise<GhlContact[]> {
  const apiKey = process.env.HIGHLEVEL_API_KEY;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!apiKey || !locationId) {
    throw new Error('HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set in .env.local');
  }
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ locationId, query: q, limit: '20' });
  const res = await fetch(`${API_BASE}/contacts/?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GHL search "${q}" → ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const json = (await res.json()) as { contacts?: GhlContact[] };
  return json.contacts ?? [];
}

/** Every pipeline + its stage names, so a stage id can be printed as a label. */
async function ghlPipelines(): Promise<
  { id: string; name: string; stages: { id: string; name: string }[] }[]
> {
  const apiKey = process.env.HIGHLEVEL_API_KEY;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  const res = await fetch(`${API_BASE}/opportunities/pipelines?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GHL pipelines → ${res.status}`);
  const json = (await res.json()) as {
    pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[];
  };
  return (json.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: p.stages ?? [] }));
}

/** Opportunities for one contact in one pipeline — the call
 *  findAllOpportunitiesForContact makes (src/lib/integrations/highlevel.ts). */
async function ghlOpportunities(
  contactId: string,
  pipelineId: string,
): Promise<{ id: string; name?: string; pipelineStageId?: string; status?: string }[]> {
  const apiKey = process.env.HIGHLEVEL_API_KEY;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  const params = new URLSearchParams({
    location_id: locationId!,
    pipeline_id: pipelineId,
    contact_id: contactId,
  });
  const res = await fetch(`${API_BASE}/opportunities/search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    opportunities?: { id: string; name?: string; pipelineStageId?: string; status?: string }[];
  };
  return json.opportunities ?? [];
}

const nameOf = (c: GhlContact) =>
  c.contactName ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)');
const uniqById = (cs: GhlContact[]) => Array.from(new Map(cs.map((c) => [c.id, c])).values());
const digits10 = (s: string) => s.replace(/\D/g, '').slice(-10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The 18 customers to migrate, with the service address Homeworks holds —
 *  shown next to each candidate so an ambiguous set is resolvable by eye.
 *  David Alfaro is deliberately absent: already correct in the tool as #1191. */
const CUSTOMERS: { name: string; address: string; doc: string }[] = [
  { name: 'Michael Green', address: '57 Nearwater Avenue, Massapequa NY 11758', doc: 'inv #3' },
  { name: 'Miguel Vias', address: '39 Vail St, Northport NY', doc: 'inv #4' },
  { name: 'Robert Florio', address: '20 Hempstead Avenue, Lynbrook NY 11563', doc: 'inv #5 + #7 (two properties)' },
  { name: 'Nicole Kohner', address: '8 Terrace Park, NY 11530', doc: 'inv #6' },
  { name: 'Anthony Infranco', address: '53 Ocean Ave, Amityville NY 11701', doc: 'inv #8' },
  { name: 'Raymond Brown', address: '2 Tap Court, Nesconset NY 11767', doc: 'inv #9' },
  { name: 'Rodney Smith', address: '72 Anndom Ct, NY', doc: 'inv #10' },
  { name: 'Jane Laguerre', address: '43 Babylon Avenue, West Islip NY 11795', doc: 'inv #11' },
  { name: "Mary O'Connor", address: '1 Granada Pl, Massapequa NY', doc: 'inv #12' },
  { name: 'Asharib Iqbal', address: '1284 Dutch Broadway, Franklin Square NY 11003', doc: 'inv #13' },
  { name: 'Kathy Polera', address: '3775 New York Avenue, Seaford NY 11783', doc: 'inv #14' },
  { name: 'Kevin Egan', address: '3786 Clark Street, Seaford NY 11783', doc: 'inv #15' },
  { name: 'Ryan Roth', address: '280 Dolphin Drive, Woodmere NY 11598', doc: 'inv #16' },
  { name: 'Steve Herman', address: '(from estimate #102)', doc: 'est #102' },
  { name: 'Vincent Barbieri', address: '(from estimate #158)', doc: 'est #158' },
  { name: 'David Antonacci', address: '(from estimate #119)', doc: 'est #119' },
  { name: 'Mrs Jones', address: '(from estimate #60)', doc: 'est #60' },
  { name: 'Angelo Ditroia', address: '163 Brewster Road, Massapequa NY 11758', doc: 'est #34' },
];

type Verdict = 'MATCH' | 'AMBIGUOUS' | 'NONE';

async function main() {
  const results: {
    customer: string;
    doc: string;
    verdict: Verdict;
    candidates: GhlContact[];
  }[] = [];

  for (const c of CUSTOMERS) {
    let hits: GhlContact[] = [];
    try {
      hits = uniqById(await ghlSearch(c.name));
    } catch (err) {
      console.error(`  ! search failed for ${c.name}:`, (err as Error).message);
    }
    // Keep only candidates whose name actually contains both name parts —
    // GHL's search is fuzzy and returns partial-token noise.
    const parts = c.name.split(/\s+/).map(norm).filter((p) => p.length > 2);
    const tight = hits.filter((h) => {
      const n = norm(nameOf(h));
      return parts.every((p) => n.includes(p));
    });
    const verdict: Verdict = tight.length === 1 ? 'MATCH' : tight.length === 0 ? 'NONE' : 'AMBIGUOUS';
    results.push({ customer: c.name, doc: c.doc, verdict, candidates: tight });
  }

  console.log('\n═══ HOMEWORKS → GOHIGHLEVEL IDENTITY ═══\n');
  for (const r of results) {
    const src = CUSTOMERS.find((c) => c.name === r.customer)!;
    console.log(`${r.verdict.padEnd(9)} ${r.customer}  (${r.doc})`);
    console.log(`          homeworks address: ${src.address}`);
    for (const c of r.candidates) {
      const addr = [c.address1, c.city, c.postalCode].filter(Boolean).join(', ') || '(no address)';
      console.log(
        `          → ${nameOf(c)} | ${c.email ?? '(no email)'} | ${c.phone ?? '(no phone)'}` +
          ` | ${addr} | id ${c.id}`,
      );
    }
    console.log('');
  }

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log('─── tally ───');
  console.log(`  MATCH      ${tally.MATCH ?? 0}`);
  console.log(`  AMBIGUOUS  ${tally.AMBIGUOUS ?? 0}   (Jason picks the right record)`);
  console.log(`  NONE       ${tally.NONE ?? 0}   (no GHL contact — needs a decision)`);
  console.log(`  total      ${results.length}`);

  // Emit the resolved identities as JSON for the next phase to consume, but
  // ONLY the unambiguous ones — an ambiguous row must not silently acquire a
  // contact id from a script.
  const resolved = results
    .filter((r) => r.verdict === 'MATCH')
    .map((r) => ({
      customer: r.customer,
      doc: r.doc,
      contactId: r.candidates[0].id,
      email: r.candidates[0].email ?? null,
      phone: r.candidates[0].phone ?? null,
      phone10: r.candidates[0].phone ? digits10(r.candidates[0].phone) : null,
    }));
  console.log(`\nresolved (unambiguous only): ${resolved.length}\n`);

  // ── Stage report ────────────────────────────────────────────────────────
  // Booking a quote moves the GHL opportunity, which can fire Jason's
  // automations. This prints where each matched contact ALREADY sits so he
  // can see which cards would move at all, and pause anything that fires.
  console.log('═══ CURRENT GOHIGHLEVEL PIPELINE STAGE ═══\n');
  const pipelines = await ghlPipelines();
  const stageName = (pid: string, sid?: string) =>
    pipelines.find((p) => p.id === pid)?.stages.find((s) => s.id === sid)?.name ?? '(unknown stage)';

  for (const r of resolved) {
    const found: string[] = [];
    for (const p of pipelines) {
      for (const o of await ghlOpportunities(r.contactId, p.id)) {
        found.push(`${p.name} → ${stageName(p.id, o.pipelineStageId)}  [${o.status ?? '?'}]`);
      }
    }
    console.log(`${r.customer}`);
    if (found.length === 0) console.log('   (no opportunity card in any pipeline)');
    for (const f of found) console.log(`   ${f}`);
    console.log('');
  }

  console.log('─── pipelines in this location ───');
  for (const p of pipelines) console.log(`  ${p.name} (${p.stages.length} stages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
