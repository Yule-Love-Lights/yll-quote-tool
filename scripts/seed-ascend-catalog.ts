/* scripts/seed-ascend-catalog.ts — seed the ASCEND by Dauer permanent-lighting
 * catalog into inventory_catalog (#82 P8 PR-2).
 *
 * Usage:
 *   npx tsx scripts/seed-ascend-catalog.ts
 *   # or:  npm run seed-ascend-catalog
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, falling
 * back to .env.local. Idempotent: upsertCatalogItems keys on `sku` and writes
 * ONLY vendor columns (name/cost/etc.), so re-running never clobbers an
 * operator's yll_category or locked flags. Run once after the P8 PR-2 deploy,
 * and again whenever ASCEND_CATALOG changes (a new SKU or a re-priced part).
 *
 * The service-role key bypasses RLS — never commit it, never expose it to the
 * browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env.local loader (tsx doesn't auto-load it like Next does). Only sets
// vars that aren't already present in the ambient environment. Must run BEFORE
// importing anything that builds the Supabase client from process.env.
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
    // no .env.local — rely on the ambient environment
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (env or .env.local).');
    process.exit(1);
  }

  // Import AFTER env is loaded so the service client picks up the vars.
  const { ASCEND_CATALOG } = await import('../src/lib/inventory/ascendCatalog');
  const { upsertCatalogItems } = await import('../src/lib/inventory/catalog');

  const imported = await upsertCatalogItems(ASCEND_CATALOG);
  console.log(`ASCEND catalog seeded: ${imported}/${ASCEND_CATALOG.length} SKUs upserted into inventory_catalog.`);
  console.log('Operator yll_category / locked flags were left untouched (vendor columns only).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
