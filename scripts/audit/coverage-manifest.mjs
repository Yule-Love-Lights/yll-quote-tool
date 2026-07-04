#!/usr/bin/env node
// #110 audit — coverage-manifest generator.
// Assigns every tracked file under the audited surfaces to exactly ONE wave
// (first matching rule wins), writes docs/audit/COVERAGE-MANIFEST-2026-07.md,
// and EXITS NONZERO if any file is unassigned. Waves re-run this at wave start
// (the plan re-freezes the baseline per wave) to catch files added since.
//
// Usage: node scripts/audit/coverage-manifest.mjs

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const SURFACES = ['src', 'scripts', 'db', 'migrations', 'public'];
const ROOT_CONFIGS = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts',
  'next-env.d.ts', 'eslint.config.mjs', 'postcss.config.mjs',
  'vitest.config.ts', 'vercel.json',
];

const WAVE_TITLES = {
  W1: 'Money core',
  W2: 'Data layer (SHARED — Naldo heads-up on fixes)',
  W3: 'Dense files / design editor & quote builder',
  W4: 'Portal',
  W5: 'AI / training',
  W6: 'API routes + cross-cutting (auth perimeter, config, scripts)',
  W7: "Naldo's areas — READ-ONLY (handoff, no routine PRs from us)",
};

// Ordered rules — FIRST MATCH WINS. Judgment calls documented inline; the
// manifest doc reproduces these notes.
const RULES = [
  // ---------- W1 money core ----------
  ['W1', /^src\/lib\/pricing\//],
  ['W1', /^src\/lib\/quoteForm\./],
  ['W1', /^src\/lib\/(invoices|invoiceStatus|balanceCollection|amend|jobs|jobStatus|quoteStatus|displayId)\./],
  ['W1', /^src\/lib\/serviceType\./], // canonical quote service-line type — quote-domain spine
  // Post-wave-0 money engines added by later features (#88 permanent install, event lighting).
  // Assigned to W1 (money domain) to keep coverage green (W6-007 drift fix); they still need a
  // dedicated MONEY-LENS AUDIT — HANDED TO NALDO (his #88/event code). See AUDIT-2026-07-NALDO-HANDOFF.md.
  ['W1', /^src\/lib\/(event|permanent)\//],
  ['W1', /^src\/lib\/(agreedTotal|money)\./], // shared money helpers (resolveAgreedTotal W1-001, round2)
  ['W1', /^src\/lib\/pipeline\//],
  ['W1', /^src\/lib\/integrations\/(valor|highlevel|quoteMessages)/],
  ['W1', /^src\/lib\/integrations\/types\.ts$/], // shared integration types — one owner (money integrations)
  ['W1', /^src\/app\/api\/(quote|pipeline)\//], // quote-create route + pipeline actions = quote lifecycle
  ['W1', /^src\/lib\/design\/projectScene\./], // produces the per-unit line items = money
  ['W1', /^src\/lib\/portal\/adapter\./], // audited ONCE here; portal-lens findings tagged forward to W4 (plan)
  ['W1', /^src\/app\/api\/quotes\//], // the whole quote lifecycle IS the money path (send/approve/amend/pay/status)
  ['W1', /^src\/app\/api\/integrations\/(valor|highlevel)\//],
  ['W1', /^src\/app\/api\/(invoices|jobs)\//], // money-bearing routes regardless of console ownership (plan)

  // ---------- W2 data layer ----------
  ['W2', /^src\/lib\/(quotes|designs|designClone|supabase\w*|trainingExamples|customers|rebook|customUploads|appSettings)\./],
  ['W2', /^src\/app\/api\/(maintenance|designs|uploads)\//],
  ['W2', /^src\/app\/api\/customers\//], // rebook route pairs with lib/rebook
  ['W2', /^src\/lib\/(appSettingsPut|customUploadsDelete|trainingExamplesList)\./], // put/list/delete siblings of W2 data modules
  ['W2', /^src\/app\/api\/admin\/customers\//], // #306 backfill — customers data domain
  ['W2', /^db\//],
  ['W2', /^migrations\//],

  // ---------- W3 dense files / design editor & builder ----------
  ['W3', /^src\/components\/design\//], // editor-core (REFACTOR-FROZEN) + canvas components
  ['W3', /^src\/components\/quote\//], // QuoteBuilder.tsx 3.3kL + DesignSummary
  ['W3', /^src\/app\/quote\//],
  ['W3', /^src\/app\/training\/new\//], // the 1.5kL dense page (rest of training → W5)
  ['W3', /^src\/lib\/useImageZoomPan\./], // editor zoom/pan util
  ['W3', /^src\/lib\/design\/sceneTypes\./], // shared scene vocabulary (relay-locked)

  // ---------- W4 portal ----------
  ['W4', /^src\/app\/portal\//],
  ['W4', /^src\/components\/portal\//],
  ['W4', /^src\/lib\/portal\//], // rest of lib/portal (adapter already W1)
  ['W4', /^src\/lib\/design\/(colorSchemes|photoLabels)\./], // portal-facing design data
  ['W4', /^src\/lib\/googleReviews\./], // portal reviews (#22)

  // ---------- W5 AI / training ----------
  ['W5', /^src\/lib\/(photoAnalysis|fewShot|embeddings|training|claude|googleMaps|geo|seedFinalDiff|seedFinalStats|referenceAssets)\./],
  ['W5', /^src\/lib\/design\/(seedFromAnalysis|sceneCorrections|sceneToFewShot|seedRoofline)\./],
  ['W5', /^src\/lib\/design\/yardstickPpf\./], // shared axis-aware ppf helper (W5-001)
  ['W5', /^src\/lib\/analyzeWithFewShot\./], // AI analysis entry
  ['W5', /^src\/app\/training\//], // rest of training pages
  ['W5', /^src\/components\/training\//],
  ['W5', /^src\/app\/api\/(analyze-address|analyze-photo|streetview|training|training-examples|references)\//],

  // ---------- W7 Naldo's areas (before W6 catch-alls) ----------
  ['W7', /^src\/app\/page\.tsx$/],
  ['W7', /^src\/app\/(inbox|insights|customers|inventory)\//],
  ['W7', /^src\/(components|lib)\/(dashboard|inventory)\//],
  ['W7', /^src\/app\/api\/(dashboard|inbox|inventory)\//],
  ['W7', /^src\/app\/api\/integrations\/(telegram|whatsapp)\//], // inbox ingest webhooks
  ['W7', /^src\/lib\/integrations\/(gmail|telegram\w*|whatsapp\w*)\./], // inbox ingest/notify libs (Naldo)
  ['W7', /^src\/app\/admin\/(jobs|invoices)\//], // console PAGES (their money ROUTES are W1)

  // ---------- W6 routes + cross-cutting ----------
  ['W6', /^src\/middleware\.ts$/],
  ['W6', /^src\/lib\/auth\//], // the #81 perimeter itself
  ['W6', /^src\/lib\/(security|rateLimit|clientSettings)\./],
  ['W6', /^src\/lib\/settings\//],
  ['W6', /^src\/app\/(login|settings|photos)\//], // photos = the non-/api image-serving route
  ['W6', /^src\/app\/admin\/quotes\//], // operator oversight pages (Jason's)
  ['W6', /^src\/app\/(layout\.tsx|globals\.css|favicon\.ico)$/],
  ['W6', /^src\/components\/(OperatorShell\.tsx|settings\/|admin\/)/],
  ['W6', /^src\/app\/api\/(account|admin\/users|auth|settings|health|login)\//],
  ['W6', /^src\/app\/api\/integrations\/homeworks\//], // dormant #16 seams — dead-code lens
  ['W6', /^src\/lib\/integrations\/homeworks\.ts$/], // dormant #16
  ['W6', /^scripts\//],
  ['W6', /^public\//], // static assets — low-priority sweep
];

const list = (paths) =>
  execSync(`git ls-files ${paths.join(' ')}`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

const files = [...list(SURFACES), ...list(ROOT_CONFIGS).map((f) => f)];
ROOT_CONFIGS.forEach((f) => { if (!files.includes(f)) files.push(f); });

const assigned = new Map(Object.keys(WAVE_TITLES).map((w) => [w, []]));
const unmatched = [];
const rootConfigSet = new Set(ROOT_CONFIGS);

for (const f of files) {
  if (rootConfigSet.has(f)) { assigned.get('W6').push(f); continue; }
  const rule = RULES.find(([, re]) => re.test(f));
  if (rule) assigned.get(rule[0]).push(f);
  else unmatched.push(f);
}

if (unmatched.length) {
  console.error(`UNASSIGNED (${unmatched.length}):`);
  unmatched.forEach((f) => console.error('  ' + f));
  process.exit(1);
}

const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const total = files.length;

let md = `# Coverage manifest (#110)

> **Authoritative** file→wave assignment for the quality audit (supersedes the
> indicative scopes in \`AUDIT-PLAN-2026-07.md\`). Generated by
> \`scripts/audit/coverage-manifest.mjs\` — re-run it at each wave start; it
> exits nonzero if any tracked file under the audited surfaces is unassigned.
>
> Generated at \`${sha}\` · **${total} files, 100% assigned.**
>
> Judgment calls (documented in the generator's rules):
> - \`api/quotes/**\` is ALL wave 1 — the quote lifecycle (send/approve/amend/pay/status) IS the money path.
> - \`portal/adapter.ts\` audited once in W1; portal-lens findings tagged forward to W4's disposition.
> - money-bearing \`api/invoices/**\` + \`api/jobs/**\` → W1 even though the console PAGES are W7 (Naldo).
> - telegram/whatsapp webhooks → W7 (inbox ingest); valor/highlevel → W1 (money).
> - homeworks routes → W6 (dormant #16 seams — dead-code lens).
> - \`lib/design/*\` is split by file: projectScene→W1 · sceneTypes→W3 · colorSchemes/photoLabels→W4 · seed*/sceneCorrections/sceneToFewShot→W5.
> - \`app/customers/**\` → W7 (Naldo-built dashboard surface; the #80 CRITICAL pages).

`;

for (const [w, fs] of assigned) {
  fs.sort();
  md += `## ${w} — ${WAVE_TITLES[w]} (${fs.length})\n\n`;
  md += fs.map((f) => `- \`${f}\``).join('\n') + '\n\n';
}

writeFileSync('docs/audit/COVERAGE-MANIFEST-2026-07.md', md);
console.log(`OK — ${total} files assigned:`);
for (const [w, fs] of assigned) console.log(`  ${w}: ${fs.length}`);
