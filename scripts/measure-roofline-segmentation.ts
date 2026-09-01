// Read-only baseline/after measurement for the roofline under-segmentation
// investigation. Compares the AI's first-pass analysis against the staff-final
// scene for every training_examples row that has a first-pass analysis.
//
// Usage: npx tsx scripts/measure-roofline-segmentation.ts [--out <file>]
//
// Prints: segment-count + footage comparison broken out by staff-final
// footage size band, for both santas (front) and gingerbread (ridge+sides)
// roofline types, plus satellite-geometry-presence rate by size band (the
// zero-overlap signal from the orchestrator's Finding 2). Writes the raw
// per-row numbers to JSON (default scripts/.roofline-baseline.json) so a
// later run can diff before vs after.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { sceneToFewShotPieces } from '../src/lib/design/sceneToFewShot';
import type { DesignScene, DesignSatelliteLines } from '../src/lib/designs';

// Same .env.local loader convention as scripts/backfill-archive-night-photos.ts
// (no dotenv dependency in this repo) — split-based, no regex match method.
function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key) || process.env[key]) continue;
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }
}
loadEnvLocal();

type Row = {
  id: string;
  created_at: string;
  excluded: boolean;
  street_w: number | null;
  street_h: number | null;
  satellite_lines: DesignSatelliteLines | null;
  original_analysis: Record<string, unknown> | null;
  final_scene: DesignScene;
  final_inputs: { santasFootage: number; gingerbreadFootage: number } | null;
};

type LineSeg = { points: [number, number][]; label?: string };

function asLines(v: unknown): LineSeg[] {
  return Array.isArray(v) ? (v as LineSeg[]) : [];
}
function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// BANDING PITFALL (learned the hard way, keep this note): band by staff-final
// SANTAS footage alone, NOT santas+gingerbread total. My first attempt banded
// by `staffTotalFootage` (this script's `band` field) and got a materially
// different, WRONG distribution (n=1,2,27,8 across the four bands below,
// dominated by the 100-199ft band) that did not match the independently
// reported bias numbers at all. Re-banding by `staffSantasFootage` alone
// (filtering to rows where it's >0, i.e. the santas package was actually
// quoted) reproduces the reported distribution (n=14,16,6,2) and bias
// percentages (-3.5%/-20.2%/-43.8%/-72.5%) almost exactly. The prompt's own
// TYPICAL LI HOUSE SIZES table characterizes house size by the FRONT edge
// (santas) alone, not by santas+gingerbread combined -- that's the metric
// that matches. See the per-row `staffSantasFootage` field in the JSON output
// if you need to re-band without re-running the query.
const SIZE_BANDS: { label: string; min: number; max: number }[] = [
  { label: 'under 50ft', min: 0, max: 50 },
  { label: '50-99ft', min: 50, max: 100 },
  { label: '100-199ft', min: 100, max: 200 },
  { label: '200ft+', min: 200, max: Infinity },
];

function bandFor(ft: number): string {
  return SIZE_BANDS.find((b) => ft >= b.min && ft < b.max)?.label ?? 'unknown';
}

type PerRow = {
  id: string;
  created_at: string;
  excluded: boolean;
  staffTotalFootage: number;
  band: string;
  aiSantasSegStreet: number;
  aiGingerbreadSegStreet: number;
  aiSantasSegSat: number;
  aiGingerbreadSegSat: number;
  staffSantasSeg: number;
  staffGingerbreadSeg: number;
  aiSantasFootage: number; // street
  aiGingerbreadFootage: number; // street
  aiSatSantasFootage: number;
  aiSatGingerbreadFootage: number;
  preferredSource: 'street' | 'satellite' | 'unset';
  aiChosenFootage: number; // whichever source the analyzer preferred, santas+gingerbread
  staffSantasFootage: number;
  staffGingerbreadFootage: number;
  hasSatelliteGeometry: boolean; // AI satellite santas or gingerbread non-empty
};

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outPath =
    outArgIdx >= 0 && process.argv[outArgIdx + 1]
      ? process.argv[outArgIdx + 1]
      : 'scripts/.roofline-baseline.json';

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.');
    process.exit(1);
  }
  const sb = createClient(url, key);

  const { data, error } = await sb
    .from('training_examples')
    .select(
      'id, created_at, excluded, street_w, street_h, satellite_lines, original_analysis, final_scene, final_inputs',
    )
    .not('original_analysis', 'is', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as Row[];
  // Fix round (PR #916, admin lens MED): `excluded` is this repo's own
  // bad-data flag on training_examples (same convention as
  // scripts/satellite-footage-report.ts, fixed in PR #918/f6b5a2a8) and must
  // not silently skew the headline stats below. Report the count up front —
  // the old log line here claimed excluded rows were "flagged below" while
  // nothing downstream ever filtered or flagged them; this replaces that
  // false claim with a true one.
  const excludedCount = rows.filter((r) => r.excluded).length;
  console.log(
    `Fetched ${rows.length} training_examples rows with a first-pass analysis; ` +
      `${excludedCount} are excluded=true (bad-data) and are dropped from every headline stat below ` +
      `(raw per-row data, including excluded rows each tagged with their own "excluded" field, is still written to the JSON output).`,
  );

  const allRows: PerRow[] = [];

  for (const row of rows) {
    const oa = row.original_analysis ?? {};
    const aiSantasStreet = asLines(oa.santasLines);
    const aiGingerbreadStreet = asLines(oa.gingerbreadLines);
    const aiSantasSat = asLines(oa.satelliteSantasLines);
    const aiGingerbreadSat = asLines(oa.satelliteGingerbreadLines);

    const aiSantasFootageStreet = asNum(oa.santasFootage);
    const aiGingerbreadFootageStreet = asNum(oa.gingerbreadFootage);
    const aiSatSantasFootage = asNum(oa.satelliteSantasFootage);
    const aiSatGingerbreadFootage = asNum(oa.satelliteGingerbreadFootage);
    const preferredSourceRaw = oa.preferredSource;
    const preferredSource: PerRow['preferredSource'] =
      preferredSourceRaw === 'satellite' || preferredSourceRaw === 'street' ? preferredSourceRaw : 'unset';

    const usedSatellite = preferredSource === 'satellite';
    const aiChosenFootage = usedSatellite
      ? aiSatSantasFootage + aiSatGingerbreadFootage
      : aiSantasFootageStreet + aiGingerbreadFootageStreet;

    // Staff-final: street-space segment counts via the same projector the
    // analyzer's few-shot pipeline uses (sceneToFewShotPieces), plus the
    // final priced footage from final_inputs (what the customer was billed).
    const w = row.street_w ?? 0;
    const h = row.street_h ?? 0;
    const staffPieces =
      w > 0 && h > 0 ? sceneToFewShotPieces(row.final_scene, w, h) : { santasLines: [], gingerbreadLines: [] };

    const staffSantasFootage = asNum(row.final_inputs?.santasFootage);
    const staffGingerbreadFootage = asNum(row.final_inputs?.gingerbreadFootage);
    const staffTotalFootage = staffSantasFootage + staffGingerbreadFootage;

    allRows.push({
      id: row.id,
      created_at: row.created_at,
      excluded: row.excluded,
      staffTotalFootage,
      band: bandFor(staffTotalFootage),
      aiSantasSegStreet: aiSantasStreet.length,
      aiGingerbreadSegStreet: aiGingerbreadStreet.length,
      aiSantasSegSat: aiSantasSat.length,
      aiGingerbreadSegSat: aiGingerbreadSat.length,
      staffSantasSeg: staffPieces.santasLines.length,
      staffGingerbreadSeg: staffPieces.gingerbreadLines.length,
      aiSantasFootage: aiSantasFootageStreet,
      aiGingerbreadFootage: aiGingerbreadFootageStreet,
      aiSatSantasFootage,
      aiSatGingerbreadFootage,
      preferredSource,
      aiChosenFootage,
      staffSantasFootage,
      staffGingerbreadFootage,
      hasSatelliteGeometry: aiSantasSat.length > 0 || aiGingerbreadSat.length > 0,
    });
  }

  // Drop excluded=true rows from every headline stat below (see the fetch
  // log above). `allRows` (unfiltered, each row tagged with its own
  // `excluded` field) is what gets written to the JSON output at the end,
  // so nothing is lost -- only the aggregate math ignores bad-data rows.
  const perRow = allRows.filter((r) => !r.excluded);

  // ---- Report ----
  const n = perRow.length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const exactMatchRate = (aiKey: keyof PerRow, staffKey: keyof PerRow) =>
    perRow.filter((r) => r[aiKey] === r[staffKey]).length / n;

  console.log(`\n=== OVERALL (n=${n}) ===`);
  console.log(
    `santas segments  — AI(street) avg ${avg(perRow.map((r) => r.aiSantasSegStreet)).toFixed(2)}, staff avg ${avg(perRow.map((r) => r.staffSantasSeg)).toFixed(2)}, exact match (AI street vs staff) ${(exactMatchRate('aiSantasSegStreet', 'staffSantasSeg') * 100).toFixed(0)}%`,
  );
  console.log(
    `gingerbread segs — AI(street) avg ${avg(perRow.map((r) => r.aiGingerbreadSegStreet)).toFixed(2)}, staff avg ${avg(perRow.map((r) => r.staffGingerbreadSeg)).toFixed(2)}, exact match (AI street vs staff) ${(exactMatchRate('aiGingerbreadSegStreet', 'staffGingerbreadSeg') * 100).toFixed(0)}%`,
  );
  console.log(
    `satellite santas segments — max ${Math.max(...perRow.map((r) => r.aiSantasSegSat), 0)}, avg ${avg(perRow.map((r) => r.aiSantasSegSat)).toFixed(2)}`,
  );
  console.log(
    `satellite gingerbread segments — max ${Math.max(...perRow.map((r) => r.aiGingerbreadSegSat), 0)}, avg ${avg(perRow.map((r) => r.aiGingerbreadSegSat)).toFixed(2)}`,
  );
  console.log(
    `street santas segments — max ${Math.max(...perRow.map((r) => r.aiSantasSegStreet), 0)}`,
  );

  console.log(`\n=== BY STAFF-FINAL SIZE BAND (total santas+gingerbread footage — reference only, see BANDING PITFALL comment above) ===`);
  console.log(
    'band'.padEnd(12),
    'n'.padEnd(4),
    'aiFtg'.padEnd(8),
    'staffFtg'.padEnd(9),
    'bias%'.padEnd(8),
    'satGeomRate'.padEnd(12),
    'aiSantasSeg'.padEnd(12),
    'staffSantasSeg'.padEnd(15),
    'aiGbSeg'.padEnd(9),
    'staffGbSeg',
  );
  for (const band of SIZE_BANDS) {
    const rs = perRow.filter((r) => r.band === band.label);
    if (rs.length === 0) continue;
    const aiFtg = avg(rs.map((r) => r.aiChosenFootage));
    const staffFtg = avg(rs.map((r) => r.staffTotalFootage));
    const bias = ((aiFtg - staffFtg) / staffFtg) * 100;
    const satGeomRate = rs.filter((r) => r.hasSatelliteGeometry).length / rs.length;
    console.log(
      band.label.padEnd(12),
      String(rs.length).padEnd(4),
      aiFtg.toFixed(1).padEnd(8),
      staffFtg.toFixed(1).padEnd(9),
      `${bias >= 0 ? '+' : ''}${bias.toFixed(1)}%`.padEnd(8),
      `${(satGeomRate * 100).toFixed(0)}%`.padEnd(12),
      avg(rs.map((r) => r.aiSantasSegStreet)).toFixed(2).padEnd(12),
      avg(rs.map((r) => r.staffSantasSeg)).toFixed(2).padEnd(15),
      avg(rs.map((r) => r.aiGingerbreadSegStreet)).toFixed(2).padEnd(9),
      avg(rs.map((r) => r.staffGingerbreadSeg)).toFixed(2),
    );
  }

  console.log(`
=== BY STAFF-FINAL SANTAS FOOTAGE BAND (the metric that reproduces the reported bias numbers) ===`);
  console.log(
    'band'.padEnd(12),
    'n'.padEnd(4),
    'aiSantasFtg'.padEnd(12),
    'staffSantasFtg'.padEnd(15),
    'bias%',
  );
  const santasRows = perRow.filter((r) => r.staffSantasFootage > 0);
  const aiSantasChosen = (r: PerRow) =>
    r.preferredSource === 'satellite' ? r.aiSatSantasFootage : r.aiSantasFootage;
  for (const band of SIZE_BANDS) {
    const rs = santasRows.filter((r) => r.staffSantasFootage >= band.min && r.staffSantasFootage < band.max);
    if (rs.length === 0) continue;
    const aiFtg = avg(rs.map(aiSantasChosen));
    const staffFtg = avg(rs.map((r) => r.staffSantasFootage));
    const bias = ((aiFtg - staffFtg) / staffFtg) * 100;
    console.log(
      band.label.padEnd(12),
      String(rs.length).padEnd(4),
      aiFtg.toFixed(1).padEnd(12),
      staffFtg.toFixed(1).padEnd(15),
      `${bias >= 0 ? '+' : ''}${bias.toFixed(1)}%`,
    );
  }

  // Banded by SANTAS footage (see BANDING PITFALL comment above) -- this is
  // the metric that reproduces the reported "zero overlap" finding exactly.
  const over105Santas = perRow.filter((r) => r.staffSantasFootage > 105);
  const over105SantasWithSatGeom = over105Santas.filter((r) => r.hasSatelliteGeometry);
  console.log(
    `\nHouses with staff-final SANTAS footage > 105ft: n=${over105Santas.length}, of which ${over105SantasWithSatGeom.length} have ANY AI satellite geometry.`,
  );
  const withSatGeomS = perRow.filter((r) => r.hasSatelliteGeometry);
  const withoutSatGeomS = perRow.filter((r) => !r.hasSatelliteGeometry);
  console.log(
    `Houses WITH satellite geometry: n=${withSatGeomS.length}, avg staff-final SANTAS footage ${avg(withSatGeomS.map((r) => r.staffSantasFootage)).toFixed(1)}ft, max ${Math.max(...withSatGeomS.map((r) => r.staffSantasFootage), 0).toFixed(0)}ft`,
  );
  console.log(
    `Houses WITHOUT satellite geometry: n=${withoutSatGeomS.length}, avg staff-final SANTAS footage ${avg(withoutSatGeomS.map((r) => r.staffSantasFootage)).toFixed(1)}ft, max ${Math.max(...withoutSatGeomS.map((r) => r.staffSantasFootage), 0).toFixed(0)}ft`,
  );

  // Reference only (total-footage banding -- see BANDING PITFALL comment above).
  const over105 = perRow.filter((r) => r.staffTotalFootage > 105);
  const over105WithSatGeom = over105.filter((r) => r.hasSatelliteGeometry);
  console.log(
    `\n(reference, total-footage banding) Houses with staff-final footage > 105ft: n=${over105.length}, of which ${over105WithSatGeom.length} have ANY AI satellite geometry.`,
  );
  const withSatGeom = perRow.filter((r) => r.hasSatelliteGeometry);
  const withoutSatGeom = perRow.filter((r) => !r.hasSatelliteGeometry);
  console.log(
    `Houses WITH satellite geometry: n=${withSatGeom.length}, avg staff-final footage ${avg(withSatGeom.map((r) => r.staffTotalFootage)).toFixed(1)}ft, max ${Math.max(...withSatGeom.map((r) => r.staffTotalFootage), 0).toFixed(0)}ft`,
  );
  console.log(
    `Houses WITHOUT satellite geometry: n=${withoutSatGeom.length}, avg staff-final footage ${avg(withoutSatGeom.map((r) => r.staffTotalFootage)).toFixed(1)}ft, max ${Math.max(...withoutSatGeom.map((r) => r.staffTotalFootage), 0).toFixed(0)}ft`,
  );

  const fs = await import('fs');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // `n` now means "rows feeding the headline stats above" (excluded=true
        // rows already dropped), matching every stat printed above. The raw
        // pre-filter total and the drop count are additive fields so nothing
        // here is silently redefined without a way to recover the old total.
        // `perRow` is the FULL row set (including excluded rows, each tagged
        // with its own `excluded` field) for anyone auditing by hand.
        n,
        nRaw: allRows.length,
        excludedCount,
        perRow: allRows,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote raw per-row data to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
