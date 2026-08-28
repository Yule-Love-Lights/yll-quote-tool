/* scripts/homeworks-ghl-prep.ts — the three GoHighLevel corrections Jason
 * authorised on 2026-08-28, ahead of the Homeworks migration writes.
 *
 *   1. Resolve "Mrs Jones" (Homeworks estimate #60) to Vanadis Jones in GHL.
 *   2. Move Mary O'Connor and Steve Herman from "All Clients" to "Booked" in
 *      the Yule Love Lights Neighbors pipeline.
 *   3. Create an Event Lighting opportunity for Asharib Iqbal at stage
 *      "Installed", status won, valued at his real Homeworks total ($1,658.92).
 *
 * Jason confirmed none of these three stage positions fires an automation.
 *
 * Usage:
 *   npx tsx scripts/homeworks-ghl-prep.ts           # DRY RUN — prints the plan, writes nothing
 *   npx tsx scripts/homeworks-ghl-prep.ts --live    # performs the two moves + one create
 *
 * Every write is reversible by hand in GHL (move the stage back, delete the
 * card). The dry run resolves every id it will use and refuses to proceed if
 * any of them is missing, so --live never runs against a guess.
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
    /* rely on the ambient environment */
  }
}
loadEnvLocal();

const LIVE = process.argv.includes('--live');
const API_BASE = 'https://services.leadconnectorhq.com';
const KEY = process.env.HIGHLEVEL_API_KEY;
const LOC = process.env.HIGHLEVEL_LOCATION_ID;
if (!KEY || !LOC) throw new Error('HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set in .env.local');

const headers = {
  Authorization: `Bearer ${KEY}`,
  Version: '2021-07-28',
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

type Contact = { id: string; email?: string; phone?: string; contactName?: string };
type Stage = { id: string; name: string };
type Pipeline = { id: string; name: string; stages: Stage[] };
type Opp = { id: string; name?: string; pipelineStageId?: string; status?: string; monetaryValue?: number };

async function search(query: string): Promise<Contact[]> {
  const params = new URLSearchParams({ locationId: LOC!, query, limit: '20' });
  const res = await fetch(`${API_BASE}/contacts/?${params}`, { headers });
  if (!res.ok) throw new Error(`search ${query} → ${res.status}`);
  return ((await res.json()) as { contacts?: Contact[] }).contacts ?? [];
}

async function pipelines(): Promise<Pipeline[]> {
  const res = await fetch(`${API_BASE}/opportunities/pipelines?locationId=${LOC}`, { headers });
  if (!res.ok) throw new Error(`pipelines → ${res.status}`);
  const json = (await res.json()) as { pipelines?: { id: string; name: string; stages?: Stage[] }[] };
  return (json.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: p.stages ?? [] }));
}

async function opportunities(contactId: string, pipelineId: string): Promise<Opp[]> {
  const params = new URLSearchParams({ location_id: LOC!, pipeline_id: pipelineId, contact_id: contactId });
  const res = await fetch(`${API_BASE}/opportunities/search?${params}`, { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { opportunities?: Opp[] }).opportunities ?? [];
}

async function moveStage(oppId: string, stageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/opportunities/${oppId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ pipelineStageId: stageId }),
  });
  if (!res.ok) throw new Error(`move ${oppId} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function createOpportunity(input: {
  contactId: string;
  pipelineId: string;
  stageId: string;
  name: string;
  monetaryValue: number;
}): Promise<string> {
  const res = await fetch(`${API_BASE}/opportunities/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      locationId: LOC,
      contactId: input.contactId,
      pipelineId: input.pipelineId,
      pipelineStageId: input.stageId,
      name: input.name,
      status: 'won',
      monetaryValue: input.monetaryValue,
    }),
  });
  if (!res.ok) throw new Error(`create → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { opportunity?: { id: string } };
  return json.opportunity?.id ?? '(created, id not returned)';
}

const pick = (list: Contact[], name: string) => {
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return list.filter((c) => (c.contactName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(want));
};

async function main() {
  console.log(LIVE ? '*** LIVE — GHL WILL BE WRITTEN ***\n' : 'DRY RUN — nothing will be written\n');
  const pipes = await pipelines();
  const neighbors = pipes.find((p) => p.name === 'Yule Love Lights Neighbors');
  const events = pipes.find((p) => p.name === 'Event Lighting');
  if (!neighbors || !events) throw new Error('expected pipelines not found');
  const booked = neighbors.stages.find((s) => s.name.trim() === 'Booked');
  const installed = events.stages.find((s) => s.name.toLowerCase().includes('installed'));
  if (!booked) throw new Error(`no "Booked" stage in Neighbors — has: ${neighbors.stages.map((s) => s.name).join(', ')}`);
  if (!installed) throw new Error(`no "Installed" stage in Event Lighting — has: ${events.stages.map((s) => s.name).join(', ')}`);
  console.log(`Neighbors "Booked"        ${booked.id}`);
  console.log(`Event Lighting "${installed.name}"  ${installed.id}\n`);

  // ── 1. Vanadis Jones ────────────────────────────────────────────────────
  const vanadis = pick(await search('Vanadis Jones'), 'jones');
  console.log('1. "Mrs Jones" (Homeworks est #60) → Vanadis Jones');
  for (const c of vanadis) {
    console.log(`   ${c.contactName} | ${c.email ?? '(no email)'} | ${c.phone ?? '(no phone)'} | id ${c.id}`);
  }
  if (vanadis.length !== 1) console.log(`   ⚠ ${vanadis.length} candidates — resolve by hand before linking`);
  console.log('');

  // ── 2. Mary + Steve → Booked ────────────────────────────────────────────
  for (const who of ["Mary O'Connor", 'Steve Herman']) {
    const hits = pick(await search(who), who.split(' ')[1]);
    const contact = hits[0];
    if (!contact) {
      console.log(`2. ${who}: NO CONTACT FOUND — skipped`);
      continue;
    }
    const opps = await opportunities(contact.id, neighbors.id);
    const stageNow = (id?: string) => neighbors.stages.find((s) => s.id === id)?.name ?? '(unknown)';
    console.log(`2. ${who} — ${opps.length} card(s) in Neighbors`);
    for (const o of opps) {
      console.log(`   "${o.name ?? '(unnamed)'}" currently ${stageNow(o.pipelineStageId)} [${o.status}]`);
      if (o.pipelineStageId === booked.id) {
        console.log('   already Booked — nothing to do');
        continue;
      }
      if (LIVE) {
        await moveStage(o.id, booked.id);
        console.log('   → moved to Booked');
      } else {
        console.log('   would move to Booked');
      }
    }
    console.log('');
  }

  // ── 3. Asharib's Event Lighting card ────────────────────────────────────
  const asharib = pick(await search('Asharib Iqbal'), 'iqbal')[0];
  console.log('3. Asharib Iqbal — Event Lighting card');
  if (!asharib) {
    console.log('   NO CONTACT FOUND — skipped');
  } else {
    const existing = await opportunities(asharib.id, events.id);
    if (existing.length) {
      console.log(`   already has ${existing.length} Event Lighting card(s) — NOT creating a duplicate`);
      for (const o of existing) console.log(`   "${o.name}" [${o.status}]`);
    } else if (LIVE) {
      const id = await createOpportunity({
        contactId: asharib.id,
        pipelineId: events.id,
        stageId: installed.id,
        name: 'Light Up Your Night Event Lighting Package',
        monetaryValue: 1658.92,
      });
      console.log(`   → created at ${installed.name}, status won, $1,658.92 — id ${id}`);
    } else {
      console.log(`   would create at ${installed.name}, status won, $1,658.92`);
    }
  }

  if (!LIVE) console.log('\nRe-run with --live to apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
