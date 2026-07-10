// scripts/ghl-list-custom-fields.ts — READ-ONLY discovery helper (#GHL pipeline
// sync). Lists the HighLevel location's CONTACT custom fields (name + id) so the
// dev can find (or create, in the GHL UI) the "Quote Link" field and set
// HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK — the send route stamps the customer portal
// URL onto that field via upsertContactCustomField (src/lib/integrations/highlevel.ts)
// once it's configured; until then it skips with a console.warn.
//
// This script performs ONLY a GET. It never creates/updates/deletes anything in
// GHL — safe to run against the real production location.
//
// Usage:  npx tsx scripts/ghl-list-custom-fields.ts

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

const API_BASE = 'https://services.leadconnectorhq.com';
// Same default Version header the app's HighLevel client uses for contacts.
const API_VERSION = '2021-07-28';

// ── tiny .env.local loader (no dependency) — mirrors scripts/spikes/ghl-conversations.ts ──
function findEnvFile(): string | null {
  let dir = process.cwd();
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

type CustomField = {
  id?: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  model?: string; // 'contact' | 'opportunity' | ...
};

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

  const path = `/locations/${encodeURIComponent(locationId)}/customFields`;
  console.log(`\nrequest: GET ${path}  (Version: ${API_VERSION})`);
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: API_VERSION,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  console.log(`status: ${res.status}`);
  if (!res.ok) {
    console.error('✗ non-200 — raw body (first 800 chars):');
    console.error(text.slice(0, 800));
    process.exit(1);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('✗ response was not valid JSON:', text.slice(0, 400));
    process.exit(1);
  }

  const fields = ((json as { customFields?: CustomField[] })?.customFields ?? []) as CustomField[];
  if (fields.length === 0) {
    console.log('\n⚠ 0 custom fields returned for this location.');
    return;
  }

  const contactFields = fields.filter((f) => !f.model || f.model === 'contact');
  console.log(`\n${contactFields.length} contact custom field(s):\n`);
  for (const f of contactFields) {
    console.log(`  ${f.id ?? '(no id)'}  —  ${f.name ?? '(unnamed)'}  [${f.dataType ?? '?'}]  key=${f.fieldKey ?? '?'}`);
  }

  const quoteLinkMatch = contactFields.find((f) => (f.name ?? '').toLowerCase().includes('quote link'));
  console.log('\n---');
  if (quoteLinkMatch) {
    console.log(`✓ Found a field named "${quoteLinkMatch.name}" — id: ${quoteLinkMatch.id}`);
    console.log(`  Set:  HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK=${quoteLinkMatch.id}`);
  } else {
    console.log('No field named "Quote Link" found. Create one in GHL (Settings → Custom Fields →');
    console.log('Contact), re-run this script to get its id, then set HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
