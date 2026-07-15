/* scripts/migrate-legacy-quotes.ts — bulk-migrate legacy Jobber quotes into the
 * quote tool (holiday vertical), one draft quote + one analyzer-seeded design
 * per past install.
 *
 * Usage:
 *   npx tsx scripts/migrate-legacy-quotes.ts \
 *     --manifest scripts/legacy-migration-data/manifest.csv \
 *     --photos   scripts/legacy-migration-data/photos \
 *     [--limit N] [--only "name substring"] [--dry-run] [--live]
 *
 * Inputs:
 *   manifest.csv — one row per property (built from the Jobber export ⊕ install
 *     roster ⊕ photo folder). Only rows with include=Y are processed.
 *   photos/      — the "2025 Installs" Drive folder downloaded locally.
 *
 * Money invariant (Naldo, S-this): THE ORIGINAL PRICE IS UNTOUCHABLE. Each
 * quote's `result` is hand-constructed from the Jobber numbers verbatim (line
 * items, discount, tax AS RECORDED, total) and verified to the cent before
 * insert — the pricing engine is never allowed to (re)compute money for these
 * rows. The engine's live tax rate (8.75%) doesn't even match the historical
 * quotes (8.625% / 8.725% / untaxed), so any recompute = silent price drift.
 *   Corollary: inputs.customLineItems mirrors the same items so a builder
 * recalculate reproduces the same subtotal; but tax/total drift on recalc is
 * expected and acceptable ONLY after staff deliberately edit the quote.
 *
 * The photo analyzer (mode:'completed' — reads what is actually installed and
 * lit in the night photo) seeds the DESIGN geometry + a learning report; its
 * numbers never touch the quote's money.
 *
 * Safety: is_test=true by default (pilot rows are wipeable via the "Delete
 * test data" sweep and never touch customers/properties). Pass --live for the
 * real run. Resumable: completed rows are recorded in migration-state.json
 * next to the manifest and skipped on re-run.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// Minimal .env.local loader (same pattern as seed-ascend-catalog.ts) — must run
// BEFORE importing anything that builds clients from process.env.
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
    // no .env.local — rely on the ambient environment
  }
}

// ── tiny RFC-4180 CSV parser (fields with quoted commas + "" escapes) ──
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

type ManifestItem = { label: string; qty: number; amount: number; selected?: boolean | null };

type StateEntry = {
  status: 'done' | 'failed';
  quoteId?: string;
  designId?: string;
  error?: string;
  at: string;
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

const MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

// Identify an image by its magic bytes (Drive photos aren't guaranteed a file
// extension). Returns undefined when the signature isn't a supported type.
function sniffImageType(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const manifestPath = arg('--manifest');
  const photosDir = arg('--photos');
  if (!manifestPath || !photosDir) {
    console.error('Required: --manifest <manifest.csv> --photos <dir>');
    process.exit(1);
  }
  const dryRun = has('--dry-run');
  const isTest = !has('--live');
  const limit = Number(arg('--limit') ?? Infinity);
  const only = (arg('--only') ?? '').toLowerCase();

  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
    if (!dryRun && !process.env[key]) {
      console.error(`${key} must be set (env or .env.local).`);
      process.exit(1);
    }
  }

  // Import AFTER env load so service clients pick up the vars.
  const { saveQuote } = await import('../src/lib/quotes');
  const { createDesign } = await import('../src/lib/designs');
  const { runAnalyzeWithFewShot } = await import('../src/lib/analyzeWithFewShot');
  type QuoteInputs = import('../src/lib/pricing/pricingEngine').QuoteInputs;
  type QuoteResult = import('../src/lib/pricing/pricingEngine').QuoteResult;
  type AnalysisSeed = import('../src/lib/design/seedFromAnalysis').AnalysisSeed;

  const statePath = join(dirname(resolve(manifestPath)), 'migration-state.json');
  const learnPath = join(dirname(resolve(manifestPath)), 'learning-report.jsonl');
  const state: Record<string, StateEntry> = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {};
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  const rows = parseCsv(readFileSync(resolve(manifestPath), 'utf8'));
  const jobs = rows.filter(r =>
    r.include === 'Y' &&
    (!only || r.client_name.toLowerCase().includes(only)),
  ).slice(0, limit);

  console.log(`${jobs.length} manifest rows to process (dryRun=${dryRun} isTest=${isTest})`);
  let done = 0, failed = 0, skipped = 0;

  for (const r of jobs) {
    const key = `${r.invoice_nos}|${r.street}`;
    if (state[key]?.status === 'done') { skipped++; continue; }
    const who = `${r.client_name} — ${r.street}`;
    try {
      // ── 1. Invoice money (what the customer actually paid), verified to the cent ──
      const items: ManifestItem[] = JSON.parse(r.line_items_json);
      const subtotal = Number(r.subtotal);
      const discount = Number(r.discount);
      const tax = Number(r.tax);
      const total = Number(r.total);
      const itemSum = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      if (Math.abs(itemSum - subtotal) > 0.02) {
        throw new Error(`line items sum $${itemSum} ≠ subtotal $${subtotal} (invoices ${r.invoice_nos}) — resolve in manifest first`);
      }
      if (Math.abs(subtotal - discount + tax - total) > 0.02) {
        throw new Error(`money mismatch: ${subtotal} − ${discount} + ${tax} ≠ ${total}`);
      }
      if (total <= 0) {
        throw new Error('zero-dollar quote — supply the real price in the manifest before migrating');
      }

      // ── 2. photo ──
      const photoFile = (r.photo_files || '').split(';').filter(Boolean)[0];
      if (!photoFile) throw new Error('no photo file');
      const buf = readFileSync(join(photosDir, photoFile));
      // Sniff the type from magic bytes first — some Drive photos have no file
      // extension (e.g. "Marie Mulligan"), and the bytes are more reliable than
      // the name anyway. Fall back to the extension only if the sniff is unsure.
      const mediaType = sniffImageType(buf) ?? MEDIA[photoFile.split('.').pop()!.toLowerCase()];
      if (!mediaType) throw new Error(`could not determine image type for ${photoFile}`);
      const photoBase64 = buf.toString('base64');

      // ── 3. analyze the completed install (design + learning only — no money) ──
      const analysis = dryRun
        ? { result: null, analysisError: 'dry-run: analysis skipped' }
        : await runAnalyzeWithFewShot(photoBase64, mediaType, undefined, { mode: 'completed' }, `[migrate ${r.invoice_nos}]`);

      appendFileSync(learnPath, JSON.stringify({
        at: new Date().toISOString(),
        client: r.client_name, street: r.street, invoiceNos: r.invoice_nos,
        invoiceItems: items.map(i => ({ label: i.label, qty: i.qty, amount: i.amount })),
        invoiceSubtotal: subtotal, invoiceTotal: total, taxmode: r.taxmode,
        analyzer: analysis.result ? {
          santasFootage: analysis.result.santasFootage,
          gingerbreadFootage: analysis.result.gingerbreadFootage,
          miniLights: analysis.result.miniLightDetections.length,
          wreaths: analysis.result.wreathDetections.map(w => `${w.size}/${w.tier}`),
          spritzers: analysis.result.spritzerDetections.map(s => s.size),
          garland: analysis.result.garlandDetections.length,
          confidence: analysis.result.confidence,
          notes: analysis.result.notes,
        } : { error: analysis.analysisError ?? 'analyzer unavailable' },
      }) + '\n');

      if (dryRun) { done++; console.log(`DRY ${who}`); continue; }

      // ── 4. quote row: invoice numbers verbatim (what they actually paid) ──
      const invoiceSlug = (r.invoice_nos || 'inv').trim().replace(/\s+/g, '-');
      const customLineItems = items.map((i, idx) => ({
        id: `legacy-${invoiceSlug}-${idx}`,
        label: i.qty > 1 ? `${i.label} ×${i.qty}` : i.label,
        amount: i.amount, // Jobber line TOTAL; quantity stays 1 so amount×qty = amount
        quantity: 1,
      }));
      const inputs: QuoteInputs = {
        santasFootage: 0, santasDifficulty: 'medium',
        gingerbreadFootage: 0, gingerbreadDifficulty: 'medium',
        winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
        stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
        miniLightItems: [], spritzers: [], wreaths: [], garland: [],
        customLineItems,
        takedown: 'included', rushFee: false,
        ...(discount > 0 ? { discount: { type: 'flat' as const, amount: discount } } : {}),
        // Historical packages under the portal's $1,000 approve gate must stay
        // approvable at their original price.
        ...(subtotal - discount < 1000 ? { waiveMinimum: true } : {}),
      };
      const result: QuoteResult = {
        lineItems: customLineItems.map(c => ({ id: c.id, label: c.label, amount: c.amount })),
        subtotalBeforeDiscount: subtotal,
        discountAmount: discount,
        earlyInstallDiscountAmount: 0,
        subtotalAfterDiscount: Math.round((subtotal - discount) * 100) / 100,
        minimumApplied: false,
        rushFeeAmount: 0,
        takedownAmount: 0,
        taxableAmount: Math.round((subtotal - discount) * 100) / 100,
        taxAmount: tax,
        total,
        depositAmount: Math.round((total / 2) * 100) / 100,
        balanceDue: total,
        rooflineChoice: 'none',
        rooflineOptions: { santas: null, gingerbread: null },
      };
      if (Math.abs(result.subtotalAfterDiscount + result.taxAmount - result.total) > 0.02) {
        throw new Error('constructed result failed the cent-exact check');
      }

      const saved = await saveQuote(
        {
          name: r.client_name,
          address: `${r.street}, ${r.city}${r.zip ? ' ' + r.zip : ''}`,
          phone: r.phone || undefined,
          email: r.email || undefined,
        },
        inputs, result, 'holiday', isTest,
      );
      if (!saved) throw new Error('saveQuote returned null');

      // ── 5. design born from the analysis (geometry only) ──
      const a = analysis.result;
      const seed: AnalysisSeed | null = a ? {
        lines: {
          santas: (a.santasLines ?? []).map(l => l.points),
          gingerbread: (a.gingerbreadLines ?? []).map(l => l.points),
          winterWonderland: [], stakeLighting: [],
          features: {
            santas: (a.santasLines ?? []).map(l => l.feature ?? null),
            gingerbread: (a.gingerbreadLines ?? []).map(l => l.feature ?? null),
          },
        },
        detections: {
          miniLights: (a.miniLightDetections ?? []).map(d => ({
            type: d.type, wrapStyle: d.wrapStyle, stringCount: d.stringCount, box: d.box,
          })),
          wreaths: (a.wreathDetections ?? []).map(d => ({ size: d.size, tier: d.tier, box: d.box })),
          spritzers: (a.spritzerDetections ?? []).map(d => ({ size: d.size, box: d.box })),
          garland: (a.garlandDetections ?? []).map(d => ({ length: d.length, tier: d.tier, box: d.box })),
        } as AnalysisSeed['detections'],
        calibration: { santasFootage: a.santasFootage, gingerbreadFootage: a.gingerbreadFootage },
      } : null;

      const design = await createDesign({
        quoteId: saved.id,
        photoBase64,
        photoMediaType: mediaType,
        ...(seed ? { seedAnalysis: seed } : {}),
      });
      if (!design) throw new Error(`quote ${saved.id} created but design creation FAILED`);
      if (design.seedFailed) console.warn(`  ⚠ ${who}: design ${design.id} photo/seed partially failed — re-check in builder`);
      if (!a) console.warn(`  ⚠ ${who}: analyzer unavailable — design has photo but no auto-seeded geometry`);

      state[key] = { status: 'done', quoteId: saved.id, designId: design.id, at: new Date().toISOString() };
      saveState();
      done++;
      console.log(`OK  ${who} → quote ${saved.id} ($${total}) design ${design.id}`);
    } catch (err) {
      failed++;
      state[key] = { status: 'failed', error: String(err), at: new Date().toISOString() };
      saveState();
      console.error(`ERR ${who}: ${String(err)}`);
    }
  }

  console.log(`\ndone=${done} failed=${failed} skipped(already done)=${skipped}`);
  console.log(`state: ${statePath}\nlearning report: ${learnPath}`);
  if (!dryRun) {
    console.log(isTest
      ? 'PILOT MODE (is_test=true): rows are wipeable via Settings → Delete test data.'
      : 'LIVE MODE: quotes are real drafts — review each in the builder before sending.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
