// SPIKE - mini-light detection accuracy baseline + retrieval-quality check.
//
// READ-ONLY. Only ever SELECTs / calls the read-only match_training_examples
// RPC against the live training_examples table. Never writes.
//
// PART 1: AI-seed-vs-staff-final detection accuracy across the whole corpus,
// for mini-light areas AND the other detection surfaces (wreaths, spritzers,
// santas/gingerbread roofline segments) for cross-comparison.
//
// PART 2: retrieval quality - does whole-photo similarity retrieval actually
// surface examples with comparable mini-light ground truth? No VOYAGE_API_KEY
// is configured in this environment (confirmed absent from .env.local), so
// this does NOT call Voyage to embed a new query image. Instead it uses each
// already-embedded row's OWN stored embedding as a stand-in query vector (a
// self-as-query proxy - pgvector search never needs Voyage once a vector
// exists) and calls the real match_training_examples RPC through the app's
// own getSimilarTrainingExamples(), self-row excluded from the results. This
// exercises the REAL similarity path end-to-end, before vs after
// biasForMiniLights, without any live model call.
//
// RUN:  npx tsx scripts/spikes/mini-detection-baseline.ts
// Creds read from .env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY),
// mirroring scripts/seed-admin.ts's loader.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TrainingExampleRow } from '../../src/lib/trainingExamples';

// Lean row shape for the outer query (Part 1's own column selection below) —
// a subset of TrainingExampleRow, not the full row (no base64 photo columns).
type LeanRow = Pick<
  TrainingExampleRow,
  'id' | 'original_analysis' | 'final_scene' | 'street_w' | 'street_h'
> & { embedding: number[] | string | null };

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // no .env.local - rely on the ambient environment
  }
}
loadEnvLocal();

async function main(): Promise<void> {
  const { getSupabaseServiceClient } = await import('../../src/lib/supabase');
  const { sceneToFewShotPieces } = await import('../../src/lib/design/sceneToFewShot');
  const { getSimilarTrainingExamplesLite } = await import('../../src/lib/trainingExamples');
  const { biasForMiniLights, FEW_SHOT_LIMIT, MINI_RESERVED_SLOTS, MINI_BIAS_POOL_SIZE } = await import('../../src/lib/fewShot');
  const { isEmbeddingConfigured } = await import('../../src/lib/embeddings');

  const sb = getSupabaseServiceClient();
  if (!sb) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured - cannot run.');
    process.exit(1);
  }

  console.log('VOYAGE_API_KEY configured: ' + isEmbeddingConfigured() + ' (expect false in this environment)\n');

  // Lean column set — the big base64 photo columns aren't needed for either
  // part of this analysis (Part 2 fetches full rows per-query via the real
  // getSimilarTrainingExamples RPC below) and pulling all of them at once in
  // a single query timed out the connection.
  const { data, error } = await sb
    .from('training_examples')
    .select('id, original_analysis, final_scene, street_w, street_h, embedding')
    .eq('excluded', false);
  if (error) {
    console.error('query failed:', error);
    process.exit(1);
  }
  const rows = (data ?? []) as LeanRow[];
  console.log('=== PART 1: AI-seed vs staff-final detection accuracy (' + rows.length + ' non-excluded rows) ===\n');

  type Metric = { exact: number; total: number; absMissSum: number };
  const metrics: Record<string, Metric> = {
    mini: { exact: 0, total: 0, absMissSum: 0 },
    wreath: { exact: 0, total: 0, absMissSum: 0 },
    spritzer: { exact: 0, total: 0, absMissSum: 0 },
    santasSegments: { exact: 0, total: 0, absMissSum: 0 },
    gingerbreadSegments: { exact: 0, total: 0, absMissSum: 0 },
  };

  let rowsWithAnyMiniWork = 0;
  let rowsWithFinalScene = 0;
  for (const r of rows) {
    if (r.street_w && r.street_h && r.street_w > 0 && r.street_h > 0) {
      rowsWithFinalScene++;
      if (sceneToFewShotPieces(r.final_scene, r.street_w, r.street_h).miniLightDetections.length > 0) {
        rowsWithAnyMiniWork++;
      }
    }
    if (!r.original_analysis || !r.street_w || !r.street_h || r.street_w <= 0 || r.street_h <= 0) continue;
    const pieces = sceneToFewShotPieces(r.final_scene, r.street_w, r.street_h);
    const seed = r.original_analysis as Record<string, unknown>;
    const seedCount = (key: string) => {
      const v = seed[key];
      return Array.isArray(v) ? v.length : null;
    };
    const record = (name: keyof typeof metrics, seedN: number | null, finalN: number) => {
      if (seedN == null) return;
      metrics[name].total++;
      if (seedN === finalN) metrics[name].exact++;
      metrics[name].absMissSum += Math.abs(seedN - finalN);
    };
    record('mini', seedCount('miniLightDetections'), pieces.miniLightDetections.length);
    record('wreath', seedCount('wreathDetections'), pieces.wreathDetections.length);
    record('spritzer', seedCount('spritzerDetections'), pieces.spritzerDetections.length);
    record('santasSegments', seedCount('santasLines'), pieces.santasLines.length);
    record('gingerbreadSegments', seedCount('gingerbreadLines'), pieces.gingerbreadLines.length);
  }

  const label: Record<string, string> = {
    mini: 'mini areas (bush/tree/column/railing)',
    wreath: 'wreaths',
    spritzer: 'spritzers',
    santasSegments: 'santas roofline segments',
    gingerbreadSegments: 'gingerbread segments',
  };
  console.log(
    'Rows with ANY final mini-light work: ' +
      rowsWithAnyMiniWork +
      ' / ' +
      rowsWithFinalScene +
      ' (' +
      ((rowsWithAnyMiniWork / rowsWithFinalScene) * 100).toFixed(0) +
      '%) — context for how "rich" the corpus is baseline\n',
  );
  console.log('surface'.padEnd(38) + 'n'.padEnd(6) + 'exact %'.padEnd(10) + 'avg count miss');
  for (const key of Object.keys(metrics)) {
    const m = metrics[key];
    const pct = m.total ? ((m.exact / m.total) * 100).toFixed(0) + '%' : 'n/a';
    const avgMiss = m.total ? (m.absMissSum / m.total).toFixed(2) : 'n/a';
    console.log(label[key].padEnd(38) + String(m.total).padEnd(6) + pct.padEnd(10) + avgMiss);
  }

  console.log('\n=== PART 2: retrieval quality - mini-rich examples surfaced, pre- vs post-bias ===');
  console.log('FEW_SHOT_LIMIT=' + FEW_SHOT_LIMIT + ' MINI_RESERVED_SLOTS=' + MINI_RESERVED_SLOTS + ' MINI_BIAS_POOL_SIZE=' + MINI_BIAS_POOL_SIZE + '\n');

  const embeddedRows = rows.filter((r) => r.embedding != null);
  console.log('Rows with a stored embedding (self-as-query proxy pool): ' + embeddedRows.length);

  // Orchestrator finding (2026-08-24): the ORIGINAL version of this script,
  // and the ORIGINAL version of assembleFewShot's similarity branch, ranked
  // the wide MINI_BIAS_POOL_SIZE pool via the FULL-row RPC (base64 images
  // included) -- ~981 KB avg/row measured live, so a 24-row pool cost ~23.5
  // MB/analyze call just to RANK candidates, two thirds of it discarded
  // immediately. This script now measures the FIXED code path directly: the
  // lite RPC (id/final_scene/photo dims only, no images) ranks the wide pool,
  // and richness is computed straight from final_scene -- no base64 fetch
  // anywhere in this measurement, matching what assembleFewShot now does
  // before it hydrates only the final FEW_SHOT_LIMIT winners.
  const richnessFromLite = (row: { final_scene: unknown; street_w: number | null; street_h: number | null }) => {
    if (!row.street_w || !row.street_h || row.street_w <= 0 || row.street_h <= 0) return 0;
    return sceneToFewShotPieces(row.final_scene as Parameters<typeof sceneToFewShotPieces>[0], row.street_w, row.street_h)
      .miniLightDetections.length;
  };

  let queriesRun = 0;
  let preRichExamplesSum = 0;
  let postRichExamplesSum = 0;
  let preAnyRichQueries = 0;
  let postAnyRichQueries = 0;
  let miniNeedyQueries = 0;
  let preAnyRichMiniNeedy = 0;
  let postAnyRichMiniNeedy = 0;

  for (const queryRow of embeddedRows) {
    if (!queryRow.street_w || !queryRow.street_h) continue;
    const queryVec = queryRow.embedding;
    const vec = typeof queryVec === 'string' ? (JSON.parse(queryVec) as number[]) : queryVec;
    if (!Array.isArray(vec)) continue;

    const poolRows = (await getSimilarTrainingExamplesLite(vec, MINI_BIAS_POOL_SIZE + 1)).filter(
      (r) => r.id !== queryRow.id,
    );
    if (poolRows.length < FEW_SHOT_LIMIT) continue;
    queriesRun++;

    const preBias = poolRows.slice(0, FEW_SHOT_LIMIT);
    const postBias = biasForMiniLights(poolRows, FEW_SHOT_LIMIT, MINI_RESERVED_SLOTS, richnessFromLite);

    const preRich = preBias.filter((e) => richnessFromLite(e) > 0).length;
    const postRich = postBias.filter((e) => richnessFromLite(e) > 0).length;
    preRichExamplesSum += preRich;
    postRichExamplesSum += postRich;
    if (preRich > 0) preAnyRichQueries++;
    if (postRich > 0) postAnyRichQueries++;

    const queryPieces = sceneToFewShotPieces(queryRow.final_scene, queryRow.street_w, queryRow.street_h);
    if (queryPieces.miniLightDetections.length > 0) {
      miniNeedyQueries++;
      if (preRich > 0) preAnyRichMiniNeedy++;
      if (postRich > 0) postAnyRichMiniNeedy++;
    }
  }

  // Bytes-per-analyze-call report (orchestrator ask): row sizes measured live
  // via direct SQL against training_examples 2026-08-24 (avg full row images
  // = 981.3 KB, avg lite row / final_scene = 6.8 KB -- see PR body for the
  // exact query). Named here so the math is auditable, not asserted.
  const AVG_FULL_ROW_KB = 981.3;
  const AVG_LITE_ROW_KB = 6.8;
  const beforeFeatureKb = FEW_SHOT_LIMIT * AVG_FULL_ROW_KB; // pre-mini-bias baseline: 8 full rows
  const afterRegressionKb = MINI_BIAS_POOL_SIZE * AVG_FULL_ROW_KB; // the bug: 24 full rows just to rank
  const afterFixKb = MINI_BIAS_POOL_SIZE * AVG_LITE_ROW_KB + FEW_SHOT_LIMIT * AVG_FULL_ROW_KB; // lite-rank + hydrate 8
  console.log('\n=== Bytes fetched per analyze call (similarity branch), row sizes measured live ===');
  console.log('before this feature (8 full rows):        ~' + (beforeFeatureKb / 1024).toFixed(2) + ' MB');
  console.log('after this feature AS FLAGGED (24 full rows): ~' + (afterRegressionKb / 1024).toFixed(2) + ' MB  <- the regression');
  console.log('after the fix (24 lite + 8 full rows):     ~' + (afterFixKb / 1024).toFixed(2) + ' MB\n');

  console.log('Queries evaluated (had >=' + FEW_SHOT_LIMIT + ' similarity neighbors beyond self): ' + queriesRun);
  console.log('  of which the query house itself has real mini-light work: ' + miniNeedyQueries + '\n');
  console.log('metric'.padEnd(52) + 'pre-bias'.padEnd(12) + 'post-bias');
  console.log(
    'avg mini-rich examples per 8-pick'.padEnd(52) +
      (queriesRun ? (preRichExamplesSum / queriesRun).toFixed(2) : 'n/a').padEnd(12) +
      (queriesRun ? (postRichExamplesSum / queriesRun).toFixed(2) : 'n/a'),
  );
  console.log(
    '% queries with >=1 mini-rich example in the 8'.padEnd(52) +
      (queriesRun ? ((preAnyRichQueries / queriesRun) * 100).toFixed(0) + '%' : 'n/a').padEnd(12) +
      (queriesRun ? ((postAnyRichQueries / queriesRun) * 100).toFixed(0) + '%' : 'n/a'),
  );
  console.log(
    '% mini-needy queries with >=1 mini-rich example'.padEnd(52) +
      (miniNeedyQueries ? ((preAnyRichMiniNeedy / miniNeedyQueries) * 100).toFixed(0) + '%' : 'n/a').padEnd(12) +
      (miniNeedyQueries ? ((postAnyRichMiniNeedy / miniNeedyQueries) * 100).toFixed(0) + '%' : 'n/a'),
  );

  console.log('\nJSON summary:');
  console.log(
    JSON.stringify(
      {
        accuracyBaseline: Object.fromEntries(
          Object.keys(metrics).map((k) => [
            k,
            {
              n: metrics[k].total,
              exactPct: metrics[k].total ? metrics[k].exact / metrics[k].total : null,
              avgCountMiss: metrics[k].total ? metrics[k].absMissSum / metrics[k].total : null,
            },
          ]),
        ),
        retrieval: {
          queriesRun,
          miniNeedyQueries,
          preBias: {
            avgRichPerPick: queriesRun ? preRichExamplesSum / queriesRun : null,
            pctQueriesWithAnyRich: queriesRun ? preAnyRichQueries / queriesRun : null,
            pctMiniNeedyWithAnyRich: miniNeedyQueries ? preAnyRichMiniNeedy / miniNeedyQueries : null,
          },
          postBias: {
            avgRichPerPick: queriesRun ? postRichExamplesSum / queriesRun : null,
            pctQueriesWithAnyRich: queriesRun ? postAnyRichQueries / queriesRun : null,
            pctMiniNeedyWithAnyRich: miniNeedyQueries ? postAnyRichMiniNeedy / miniNeedyQueries : null,
          },
        },
        bytesPerAnalyzeCallKb: {
          note: 'row sizes measured live via SQL 2026-08-24, not fetched by this script',
          beforeThisFeature: beforeFeatureKb,
          afterThisFeatureAsFlagged: afterRegressionKb,
          afterTheFix: afterFixKb,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
