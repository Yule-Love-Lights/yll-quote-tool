/* scripts/homeworks-close-job.ts — close out a migrated job whose install is
 * already finished: advance it to installed -> requires_invoicing, create its
 * historical invoice from the quote's Homeworks figures, and settle it when the
 * balance is zero.
 *
 * Used for the completed jobs the main migration could not close (Rodney #1311
 * predates the close-out path). Idempotent: a job already `done` or an invoice
 * already `paid` is left alone rather than re-transitioned, which is what
 * aborted the first batch run on Asharib.
 *
 *   npx tsx scripts/homeworks-close-job.ts 1311          # DRY RUN
 *   npx tsx scripts/homeworks-close-job.ts 1311 --live
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || process.env[m[1]]) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

import { getSupabaseServiceClient } from '@/lib/supabase';
import { setJobStatus, type JobRow } from '@/lib/jobs';
import { createInvoiceFromJob, setInvoiceStatus } from '@/lib/invoices';

const LIVE = process.argv.includes('--live');
const quoteNumber = Number(process.argv[2]);
if (!Number.isFinite(quoteNumber)) throw new Error('usage: homeworks-close-job.ts <quoteNumber> [--live]');

async function main() {
  console.log(LIVE ? '*** LIVE ***' : 'DRY RUN');
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service client not configured');

  const { data: q } = await sb
    .from('quotes')
    .select('id, quote_number, customer_name, total, deposit_amount_usd')
    .eq('quote_number', quoteNumber)
    .maybeSingle();
  if (!q) throw new Error(`quote #${quoteNumber} not found`);
  const quote = q as { id: string; customer_name: string; total: number; deposit_amount_usd: number };

  const { data: jr } = await sb.from('jobs').select('*').eq('quote_id', quote.id).maybeSingle();
  if (!jr) throw new Error(`no job for quote #${quoteNumber}`);
  let job = jr as JobRow;
  const balance = Math.round((quote.total - quote.deposit_amount_usd) * 100) / 100;
  console.log(`#${quoteNumber} ${quote.customer_name} — job ${job.status}, total ${quote.total}, paid ${quote.deposit_amount_usd}, balance ${balance.toFixed(2)}`);

  if (!LIVE) return console.log('would advance to installed -> requires_invoicing, invoice, and settle if balance is 0');

  if (job.status === 'to_schedule' || job.status === 'scheduled') job = (await setJobStatus(job.id, 'installed')) ?? job;
  if (job.status === 'installed') job = (await setJobStatus(job.id, 'requires_invoicing')) ?? job;

  const inv = await createInvoiceFromJob(job.id);
  if (!inv) throw new Error('invoice not created');
  console.log(`invoice ${inv.invoice_number}: subtotal ${inv.subtotal}, tax ${inv.tax}, total ${inv.total}, deposit ${inv.deposit_applied}, balance ${inv.balance} (${inv.status})`);

  if (Number(inv.balance) <= 0.005) {
    if (inv.status !== 'paid') await setInvoiceStatus(inv.id, 'paid');
    if (job.status !== 'done') await setJobStatus(job.id, 'done');
    console.log('closed: invoice paid, job done');
  } else {
    console.log(`invoice raised, ${inv.balance} outstanding — job stays at requires_invoicing`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
