// scripts/ghl-list-pipelines.ts, READ-ONLY discovery helper (naldo/referral-
// link-sweep). Lists every HighLevel pipeline + stage (name + id) so the dev
// can eyeball the "Do Not Call" stage inside the "Yule Love Lights
// Neighbors" pipeline by hand. It could not be run live from the build
// sandbox this script was written in (no outbound network access to
// services.leadconnectorhq.com), so this script exists for you to run it
// from a machine that DOES have real GHL access.
//
// NOTE: the referral sweep itself no longer needs this script's output to
// function. src/lib/integrations/ghlPipelineMap.ts's checkNeighborsSuppression
// resolves the "Do Not Call" stage BY NAME (NEIGHBORS_DO_NOT_CALL_STAGE_NAME,
// case/whitespace-insensitive, scoped to the Neighbors pipeline) from a live
// pipeline listing on every run, and logs the id it resolved in the run
// summary (ReferralSweepSummary.resolvedDoNotCallStageId). This script is
// now just a convenient standalone way to see that id (and every other
// pipeline/stage id) without running the full sweep. Once someone has read
// the resolved id from a real run, it can be hardcoded in ghlPipelineMap.ts
// as NEIGHBORS_DECLINED_STAGE_ID's sibling, the same way "Declined for 2026"
// already is. See that file's "ASYMMETRIC ON PURPOSE" comment.
//
// This script performs ONLY a GET (/opportunities/pipelines, the same
// read-only endpoint highlevel.ts's listPipelines() wraps). It never
// creates/updates/deletes anything in GHL. Safe to run against the real
// production location.
//
// Usage:  npx tsx scripts/ghl-list-pipelines.ts

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

const API_BASE = 'https://services.leadconnectorhq.com';
// Same default Version header the app's HighLevel client uses.
const API_VERSION = '2021-07-28';

// The Neighbors pipeline id, already known (src/lib/integrations/ghlPipelineMap.ts's
// NEIGHBORS_STAGES.pipelineId). Not a secret, same as every other pipeline id
// already committed in that file.
const NEIGHBORS_PIPELINE_ID = 'TIYqklVJ349F5heaSkCs';

// tiny .env.local loader (no dependency), mirrors scripts/ghl-list-custom-fields.ts
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

type Stage = { id?: string; name?: string };
type Pipeline = { id?: string; name?: string; stages?: Stage[] };

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

  const path = `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`;
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
    console.error('✗ non-200, raw body (first 800 chars):');
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

  const pipelines = ((json as { pipelines?: Pipeline[] })?.pipelines ?? []) as Pipeline[];
  console.log(`\n${pipelines.length} pipeline(s):\n`);
  for (const p of pipelines) {
    console.log(`  ${p.id ?? '(no id)'}  :  ${p.name ?? '(unnamed)'}  (${p.stages?.length ?? 0} stage(s))`);
  }

  console.log('\n---');
  const neighbors = pipelines.find((p) => p.id === NEIGHBORS_PIPELINE_ID);
  if (!neighbors) {
    console.log(`✗ Pipeline ${NEIGHBORS_PIPELINE_ID} ("Yule Love Lights Neighbors") not found in this response.`);
    console.log('  Either the pipeline was renamed/deleted/recreated with a new id, or this token');
    console.log('  cannot see it. Check the id list above by hand.');
    return;
  }
  console.log(`Found "${neighbors.name}" (${neighbors.id}), stages:\n`);
  for (const s of neighbors.stages ?? []) {
    console.log(`  ${s.id ?? '(no id)'}  "${s.name ?? '(unnamed)'}"`);
  }

  const doNotCall = (neighbors.stages ?? []).find((s) => (s.name ?? '').toLowerCase().includes('do not call'));
  console.log('\n---');
  if (doNotCall) {
    console.log(`✓ Found a stage named "${doNotCall.name}", id: ${doNotCall.id}`);
    console.log('  The referral sweep already resolves this by name at runtime (see');
    console.log('  ghlPipelineMap.ts\'s checkNeighborsSuppression) and logs it in every run\'s');
    console.log('  summary, so this confirms the id. Optionally upgrade it to a verified');
    console.log('  hardcoded constant now, the same way NEIGHBORS_DECLINED_STAGE_ID already is:');
    console.log(`\n  export const NEIGHBORS_DO_NOT_CALL_STAGE_ID = '${doNotCall.id}'; // Do Not Call, discovered live <today's date>`);
  } else {
    console.log('✗ No stage named "Do Not Call" found under Yule Love Lights Neighbors.');
    console.log('  Check the stage list above by hand. The name may differ slightly from what');
    console.log('  was expected (e.g. capitalization, or an emoji prefix like the other stages have).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
