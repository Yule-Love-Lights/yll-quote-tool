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
  console.log(`Fetched ${rows.length} training_examples rows with a first-pass analysis (excluded rows included, flagged below).`);

  const perRow: PerRow[] = [];

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

    perRow.push({
      id: row.id,
      created_at: row.created_at,
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

  console.log(`\n=== BY STAFF-FINAL SIZE BAND (total santas+gingerbread footage) ===`);
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

  // The orchestrator's specific claim: zero overlap between "has satellite
  // geometry" and "over ~105ft final footage".
  const over105 = perRow.filter((r) => r.staffTotalFootage > 105);
  const over105WithSatGeom = over105.filter((r) => r.hasSatelliteGeometry);
  console.log(
    `\nHouses with staff-final footage > 105ft: n=${over105.length}, of which ${over105WithSatGeom.length} have ANY AI satellite geometry.`,
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
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), n, perRow }, null, 2));
  console.log(`\nWrote raw per-row data to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
