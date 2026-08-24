/**
 * scripts/satellite-footage-report.ts -- READ-ONLY report comparing, for
 * every training_examples row with a satellite image, three numbers per
 * roofline (Santa's / Gingerbread):
 *   1. MODEL-STATED  -- the value Claude wrote into satelliteSantasFootage /
 *      satelliteGingerbreadFootage in original_analysis (jsonb).
 *   2. CODE-COMPUTED -- footageFromLines() summing the model's OWN drawn
 *      satellite polylines (src/lib/design/polylineFootage.ts), using the
 *      row's real satellite_w / satellite_h / satellite_feet_per_pixel.
 *   3. STAFF-FINAL    -- final_inputs.santasFootage / gingerbreadFootage, the
 *      number the quote was actually PRICED on (ground truth).
 *
 * ZERO writes -- SELECT only. This is a recon/verification tool for the
 * deterministic-satellite-footage shadow-mode PR, not a migration or backfill
 * of any stored data.
 *
 * Usage:
 *   npx tsx scripts/satellite-footage-report.ts
 *   npx tsx scripts/satellite-footage-report.ts --json /path/to/out.json
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env.local or the
 * ambient environment) -- same client the app uses (getSupabaseServiceClient).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// -- Minimal .env.local loader (mirrors scripts/winback-recon.ts) ----------
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

import { getSupabaseServiceClient } from '../src/lib/supabase';
import { footageFromLines, satelliteFootageDisagrees, type FootagePolyline } from '../src/lib/design/polylineFootage';

type Row = {
  id: string;
  address: string | null;
  created_at: string;
  excluded: boolean;
  satellite_w: number | null;
  satellite_h: number | null;
  satellite_feet_per_pixel: number | null;
  original_analysis: Record<string, unknown> | null;
  final_inputs: Record<string, unknown> | null;
};

type LineReport = {
  modelStated: number | null;
  codeComputed: number | null;
  staffFinal: number | null;
  disagreesFromThreshold: boolean; // model-stated vs code-computed, the shadow-mode flag
  modelAbsPctVsStaff: number | null;
  computedAbsPctVsStaff: number | null;
};

type RowReport = {
  id: string;
  address: string | null;
  createdAt: string;
  excluded: boolean;
  bucket: 'computable' | 'no_satellite_image' | 'no_scale' | 'no_original_analysis';
  santas: LineReport;
  gingerbread: LineReport;
};

function pctAbs(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b <= 0) return a === 0 ? 0 : null; // undefined denominator -- can't express as a %
  return Math.abs(a - b) / b;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function linesOf(v: unknown): FootagePolyline[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is { points: unknown } => l != null && typeof l === 'object' && 'points' in l)
    .map((l) => ({
      points: Array.isArray(l.points)
        ? l.points.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
        : [],
    }));
}

async function main() {
  const sb = getSupabaseServiceClient();
  if (!sb) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured -- cannot read training_examples.');
    process.exit(1);
  }

  const { data, error } = await sb
    .from('training_examples')
    .select('id, address, created_at, excluded, satellite_w, satellite_h, satellite_feet_per_pixel, original_analysis, final_inputs')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as Row[];

  const reports: RowReport[] = rows.map((r) => {
    const hasDims = r.satellite_w != null && r.satellite_h != null && r.satellite_w > 0 && r.satellite_h > 0;
    const hasScale = r.satellite_feet_per_pixel != null && r.satellite_feet_per_pixel > 0;
    const hasAnalysis = r.original_analysis != null;

    let bucket: RowReport['bucket'];
    if (!hasAnalysis) bucket = 'no_original_analysis';
    else if (!hasDims) bucket = 'no_satellite_image';
    else if (!hasScale) bucket = 'no_scale';
    else bucket = 'computable';

    const analysis = r.original_analysis ?? {};
    const finalInputs = r.final_inputs ?? {};

    const modelSantas = hasAnalysis ? num((analysis as Record<string, unknown>).satelliteSantasFootage) : null;
    const modelGingerbread = hasAnalysis ? num((analysis as Record<string, unknown>).satelliteGingerbreadFootage) : null;
    const staffSantas = num((finalInputs as Record<string, unknown>).santasFootage);
    const staffGingerbread = num((finalInputs as Record<string, unknown>).gingerbreadFootage);

    const computedSantasRaw = bucket === 'computable'
      ? footageFromLines(linesOf((analysis as Record<string, unknown>).satelliteSantasLines), r.satellite_w, r.satellite_h, r.satellite_feet_per_pixel)
      : null;
    const computedGingerbreadRaw = bucket === 'computable'
      ? footageFromLines(linesOf((analysis as Record<string, unknown>).satelliteGingerbreadLines), r.satellite_w, r.satellite_h, r.satellite_feet_per_pixel)
      : null;
    // One rounding step, at the very end, to the nearest whole foot -- never
    // per-segment (matches the convention in photoAnalysis.ts).
    const computedSantas = computedSantasRaw == null ? null : Math.round(computedSantasRaw);
    const computedGingerbread = computedGingerbreadRaw == null ? null : Math.round(computedGingerbreadRaw);

    return {
      id: r.id,
      address: r.address,
      createdAt: r.created_at,
      excluded: r.excluded,
      bucket,
      santas: {
        modelStated: modelSantas,
        codeComputed: computedSantas,
        staffFinal: staffSantas,
        disagreesFromThreshold: modelSantas != null ? satelliteFootageDisagrees(modelSantas, computedSantasRaw) : false,
        modelAbsPctVsStaff: pctAbs(modelSantas, staffSantas),
        computedAbsPctVsStaff: pctAbs(computedSantas, staffSantas),
      },
      gingerbread: {
        modelStated: modelGingerbread,
        codeComputed: computedGingerbread,
        staffFinal: staffGingerbread,
        disagreesFromThreshold: modelGingerbread != null ? satelliteFootageDisagrees(modelGingerbread, computedGingerbreadRaw) : false,
        modelAbsPctVsStaff: pctAbs(modelGingerbread, staffGingerbread),
        computedAbsPctVsStaff: pctAbs(computedGingerbread, staffGingerbread),
      },
    };
  });

  // -- Console table -------------------------------------------------------
  const fmt = (n: number | null, unit = 'ft'): string => (n == null ? '--' : `${n}${unit}`);
  const fmtPct = (n: number | null): string => (n == null ? '--' : `${(n * 100).toFixed(1)}%`);

  console.log('\n=== Satellite footage: model-stated vs code-computed vs staff-final (per row) ===\n');
  console.log(
    ['address/id', 'bucket', 'santas: model/computed/staff', 'santas disagrees', 'ging: model/computed/staff', 'ging disagrees'].join(' | '),
  );
  for (const r of reports) {
    const label = (r.address ?? r.id).slice(0, 40);
    console.log(
      [
        label.padEnd(40),
        r.bucket.padEnd(18),
        `${fmt(r.santas.modelStated)}/${fmt(r.santas.codeComputed)}/${fmt(r.santas.staffFinal)}`.padEnd(22),
        (r.santas.disagreesFromThreshold ? 'YES' : 'no').padEnd(17),
        `${fmt(r.gingerbread.modelStated)}/${fmt(r.gingerbread.codeComputed)}/${fmt(r.gingerbread.staffFinal)}`.padEnd(22),
        r.gingerbread.disagreesFromThreshold ? 'YES' : 'no',
      ].join(' | '),
    );
  }

  // -- Corpus summary --------------------------------------------------------
  const bucketCounts: Record<string, number> = {};
  for (const r of reports) bucketCounts[r.bucket] = (bucketCounts[r.bucket] ?? 0) + 1;

  const computable = reports.filter((r) => r.bucket === 'computable');
  const disagreeCount = computable.filter((r) => r.santas.disagreesFromThreshold || r.gingerbread.disagreesFromThreshold).length;

  const collectPct = (getter: (lr: LineReport) => number | null): number[] =>
    computable.flatMap((r) => [getter(r.santas), getter(r.gingerbread)]).filter((n): n is number => n != null);

  const modelVsStaffPcts = collectPct((lr) => lr.modelAbsPctVsStaff);
  const computedVsStaffPcts = collectPct((lr) => lr.computedAbsPctVsStaff);
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  console.log('\n=== Corpus summary ===\n');
  console.log('Row buckets:', JSON.stringify(bucketCounts, null, 2));
  console.log(`Computable rows: ${computable.length} of ${reports.length} total`);
  console.log(`Rows (of computable) with a shadow-mode disagreement flag (>25% model-vs-computed on either line): ${disagreeCount}`);
  console.log(`Mean |model-stated vs staff-final| %  (n=${modelVsStaffPcts.length}): ${fmtPct(mean(modelVsStaffPcts))}`);
  console.log(`Mean |code-computed vs staff-final| % (n=${computedVsStaffPcts.length}): ${fmtPct(mean(computedVsStaffPcts))}`);

  // -- JSON artifact ---------------------------------------------------------
  const jsonFlagIdx = process.argv.indexOf('--json');
  const outPath = jsonFlagIdx >= 0 && process.argv[jsonFlagIdx + 1]
    ? resolve(process.argv[jsonFlagIdx + 1])
    : null;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          bucketCounts,
          computableCount: computable.length,
          totalCount: reports.length,
          disagreeCount,
          meanModelVsStaffPct: mean(modelVsStaffPcts),
          meanComputedVsStaffPct: mean(computedVsStaffPcts),
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
