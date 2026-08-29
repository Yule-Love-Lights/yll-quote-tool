// Dry-run the installment runner against LIVE data and print what it would do.
//
//   npx tsx scripts/installment-run-dry.ts            # today
//   npx tsx scripts/installment-run-dry.ts 2026-09-06 # any ET business day
//
// READ-ONLY BY CONSTRUCTION: `dryRun` is hardcoded true and there is no flag to
// turn it off here. To actually charge, the endpoint is the only door
// (POST /api/ops/installment-run with dryRun:false, behind two Vercel flags) —
// see src/lib/installmentRunner.ts's header.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]!]) continue;
      let val = m[2]!;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]!] = val;
    }
  } catch {
    /* ambient env */
  }
}
loadEnvLocal();

import { runInstallments } from '@/lib/installmentRunner';

async function main() {
  const arg = process.argv[2];
  // Noon UTC on the named day is mid-morning ET, safely inside the same ET
  // calendar day whichever side of a DST boundary it falls.
  const asOf = arg ? new Date(`${arg}T12:00:00Z`) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    console.error(`Not a date: ${arg}`);
    process.exit(1);
  }

  const result = await runInstallments({ asOf, dryRun: true });
  if (!result.ok) {
    console.error(`FAILED: ${result.error}`);
    process.exit(1);
  }

  console.log(`\nInstallment runner — DRY RUN for the ET business day ${result.today}\n`);
  for (const d of result.decisions) {
    const who = `${d.customerName ?? 'Unknown'} (quote #${d.quoteNumber ?? '?'})`;
    if (d.action === 'charge') {
      console.log(`  WOULD CHARGE  $${d.amountUsd?.toFixed(2)}  payment ${d.seq} due ${d.dueDate}  — ${who}`);
    } else {
      const amount = d.amountUsd == null ? '' : `$${d.amountUsd.toFixed(2)} payment ${d.seq} due ${d.dueDate} `;
      console.log(`  skip          ${amount}— ${who}`);
      console.log(`                reasons: ${d.reasons.join(', ')}`);
      if (d.detail) console.log(`                ${d.detail}`);
    }
    if (d.alsoDue > 0) console.log(`                (${d.alsoDue} further payment(s) also due, left for a later run)`);
  }
  const wouldCharge = result.decisions.filter((d) => d.action === 'charge');
  const total = wouldCharge.reduce((a, d) => a + (d.amountUsd ?? 0), 0);
  console.log(
    `\n  ${wouldCharge.length} charge(s), $${total.toFixed(2)} total, across ${result.decisions.length} plan(s). Nothing was charged.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
