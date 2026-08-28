/**
 * scripts/door-anchor-report.ts -- READ-ONLY report comparing, for every
 * `designs` row that has BOTH a staff-drawn yardstick AND a recorded
 * door-anchor scale (doorAnchorFtPerPx in seed_analysis), how far the two
 * candidate scales disagree.
 *
 * BACKGROUND: analyzePhoto() now records a SHADOW MODE door-anchor scale
 * alongside the existing analysis (src/lib/design/doorAnchor.ts + the
 * door-anchor-experiment spike, PR #922) -- a candidate alternative to the
 * staff-placed yardstick, which was measured unreliable (one address
 * yardsticked twice disagreed by 72%). Neither number is consumed by
 * pricing. This script exists to start collecting real agreement data
 * between the two, on live designs, as they accumulate.
 *
 * WHY THIS IS COMPARABLE WITHOUT ANY GEOMETRY HERE: doorAnchorFtPerPx is
 * already rescaled at analyze time (photoAnalysis.ts's
 * rescaleFtPerPxToOriginal) into the ORIGINAL uploaded street photo's pixel
 * space -- the same space the design editor's yardstick lives in (see
 * src/lib/design/yardstickPpf.ts). This script only inverts
 * firstYardstickPpf's px/ft into ft/px and compares -- no pixel-space
 * conversion happens here. That assumption (yardstick and door-anchor scale
 * live in the SAME photo's pixel grid) rests on the yardstick always being
 * drawn on the BASE street photo -- the Yardstick type carries no photoId,
 * so today it can only be that photo. If a future change lets a yardstick
 * target an extra photo, this script's comparison would need revisiting.
 *
 * WHAT THIS DOES NOT SAY: agreement (or disagreement) between the two
 * candidates is not itself proof either one is ACCURATE -- neither has been
 * checked against a ground-truth measurement (see the spike's
 * DOOR_ANCHOR_RESULTS.md, section 5). This report is descriptive only.
 *
 * POPULATION, STATED HONESTLY: this reads every row in `designs` -- it does
 * NOT read training_examples and so has no notion of that table's `excluded`
 * (bad-data) flag. A design later captured into training_examples and
 * flagged excluded there would still appear here unless it also predates any
 * door-anchor/yardstick data. If a low-quality design skews this report,
 * that would need to be cross-referenced against training_examples by hand.
 * It also does NOT join to `quotes`, so it has no notion of `quotes.is_test`
 * -- a design attached to a test quote is included exactly like a real one.
 * Immaterial today (this shadow field has barely started accumulating data),
 * but worth knowing before trusting the corpus summary at scale.
 *
 * ZERO writes -- SELECT only.
 *
 * Usage:
 *   npx tsx scripts/door-anchor-report.ts
 *   npx tsx scripts/door-anchor-report.ts --json /path/to/out.json
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env.local or the
 * ambient environment) -- same client the app uses (getSupabaseServiceClient).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// -- Minimal .env.local loader (mirrors scripts/satellite-footage-report.ts) --
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
    /* no .env.local -- rely on the ambient environment */
  }
}
loadEnvLocal();

// LOUD failure on missing config -- name the exact variables, don't just fail
// obscurely inside the Supabase client (matches this week's script convention).
const MISSING_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
if (MISSING_ENV.length > 0) {
  console.error(`Missing required env var(s): ${MISSING_ENV.join(', ')} -- checked .env.local and the ambient environment. Aborting.`);
  process.exit(1);
}

import { getSupabaseServiceClient } from '../src/lib/supabase';
import { firstYardstickPpf } from '../src/lib/design/yardstickPpf';
import type { DesignScene } from '../src/lib/designs';
import { classifyRow, mean, num, parseFtPerPx, stdev, str } from './door-anchor-report-core';

type Row = {
  id: string;
  quote_id: string | null;
  created_at: string;
  scene: DesignScene | null;
  seed_analysis: Record<string, unknown> | null;
  photo_w: number | null;
  photo_h: number | null;
};

type RowReport = {
  id: string;
  quoteId: string | null;
  createdAt: string;
  bucket: 'comparable' | 'no_seed_analysis' | 'no_door_anchor' | 'no_yardstick';
  yardstickFtPerPx: number | null;
  doorAnchorFtPerPx: number | null;
  doorAnchorSource: string | null;
  doorAnchorConfidence: number | null;
  ratio: number | null; // doorAnchor / yardstick
  pctDisagree: number | null; // |doorAnchor - yardstick| / yardstick
};

async function main() {
  const sb = getSupabaseServiceClient();
  if (!sb) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured -- cannot read designs.');
    process.exit(1);
  }

  const { data, error } = await sb
    .from('designs')
    .select('id, quote_id, created_at, scene, seed_analysis, photo_w, photo_h')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as Row[];

  const reports: RowReport[] = rows.map((r) => {
    const analysis = r.seed_analysis ?? null;
    const hasAnalysis = analysis != null;

    const doorAnchorFtPerPx = hasAnalysis
      ? parseFtPerPx((analysis as Record<string, unknown>).doorAnchorFtPerPx)
      : null;
    const doorAnchorSource = hasAnalysis ? str((analysis as Record<string, unknown>).doorAnchorSource) : null;
    const doorAnchorConfidence = hasAnalysis ? num((analysis as Record<string, unknown>).doorAnchorConfidence) : null;

    const yardstickPpf = firstYardstickPpf(r.scene);
    const yardstickFtPerPx = yardstickPpf != null && yardstickPpf > 0 ? 1 / yardstickPpf : null;

    const { bucket, ratio, pctDisagree } = classifyRow({ hasAnalysis, doorAnchorFtPerPx, yardstickFtPerPx });

    return {
      id: r.id,
      quoteId: r.quote_id,
      createdAt: r.created_at,
      bucket,
      yardstickFtPerPx,
      doorAnchorFtPerPx,
      doorAnchorSource,
      doorAnchorConfidence,
      ratio,
      pctDisagree,
    };
  });

  // -- Console table -----------------------------------------------------
  const fmt = (n: number | null, digits = 4): string => (n == null ? '--' : n.toFixed(digits));
  const fmtPct = (n: number | null): string => (n == null ? '--' : `${(n * 100).toFixed(1)}%`);

  console.log('\n=== Door-anchor vs yardstick feet-per-pixel scale (per design) ===\n');
  console.log(['id', 'bucket', 'yardstick ft/px', 'door-anchor ft/px', 'source', 'disagree %'].join(' | '));
  for (const r of reports) {
    console.log(
      [
        r.id.slice(0, 8).padEnd(10),
        r.bucket.padEnd(16),
        fmt(r.yardstickFtPerPx).padEnd(15),
        fmt(r.doorAnchorFtPerPx).padEnd(18),
        (r.doorAnchorSource ?? '--').padEnd(13),
        fmtPct(r.pctDisagree),
      ].join(' | '),
    );
  }

  // -- Corpus summary ------------------------------------------------------
  const bucketCounts: Record<string, number> = {};
  for (const r of reports) bucketCounts[r.bucket] = (bucketCounts[r.bucket] ?? 0) + 1;

  const comparable = reports.filter((r) => r.bucket === 'comparable');
  const pctDisagrees = comparable.map((r) => r.pctDisagree!).filter((n): n is number => n != null);
  const ratios = comparable.map((r) => r.ratio!).filter((n): n is number => n != null);

  console.log('\n=== Corpus summary ===\n');
  console.log(`Total designs read: ${reports.length}`);
  console.log('Row buckets:', JSON.stringify(bucketCounts, null, 2));
  console.log(`Comparable rows (have both a yardstick AND a recorded door-anchor scale): ${comparable.length} of ${reports.length}`);
  if (comparable.length > 0) {
    console.log(`Mean |door-anchor vs yardstick| disagreement: ${fmtPct(mean(pctDisagrees))} (n=${pctDisagrees.length})`);
    console.log(`Max |door-anchor vs yardstick| disagreement: ${fmtPct(pctDisagrees.length ? Math.max(...pctDisagrees) : null)}`);
    console.log(`Ratio (door-anchor / yardstick): mean=${fmt(mean(ratios), 3)} stdev=${fmt(stdev(ratios), 3)}` +
      (ratios.length ? ` min=${fmt(Math.min(...ratios), 3)} max=${fmt(Math.max(...ratios), 3)}` : ''));
  } else {
    console.log('No comparable rows yet -- run this again after more designs have both a yardstick and a door-anchor read.');
  }

  // -- JSON artifact ---------------------------------------------------------
  const jsonFlagIdx = process.argv.indexOf('--json');
  const outPath = jsonFlagIdx >= 0 && process.argv[jsonFlagIdx + 1] ? resolve(process.argv[jsonFlagIdx + 1]) : null;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          bucketCounts,
          totalCount: reports.length,
          comparableCount: comparable.length,
          meanPctDisagree: mean(pctDisagrees),
          maxPctDisagree: pctDisagrees.length ? Math.max(...pctDisagrees) : null,
          meanRatio: mean(ratios),
          stdevRatio: stdev(ratios),
          rows: reports,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\nJSON artifact written to ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
