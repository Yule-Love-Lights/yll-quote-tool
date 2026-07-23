/* scripts/valor-token-reuse-test.ts — #161/#83 ONE-OFF: prove the vault token
 * captured at deposit is reusable for a MERCHANT-INITIATED charge via Valor's
 * Tokenized Sale API (`POST /?saleToken`) — the mechanism "Charge remaining
 * balance" needs. Support (Fadil Cox, 2026-07-22) confirmed this is the
 * intended reuse path; this script is the live proof.
 *
 * Usage:
 *   npx tsx scripts/valor-token-reuse-test.ts --quote <quoteId>            # DRY-RUN (default): checks creds + token, fires NOTHING
 *   npx tsx scripts/valor-token-reuse-test.ts --quote <quoteId> --charge   # fires ONE $1.00 charge on the stored token — VOID IT in the Valor portal after
 *   [--staging]  # use securelink-staging instead of prod (a prod-minted token belongs on prod)
 *
 * Needs in .env.local: VALOR_APP_ID, VALOR_APP_KEY, VALOR_EPI (values from the
 * Valor dashboard — they are Sensitive/unreadable in Vercel), plus the
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY already there.
 *
 * Money safety:
 * - Amount is sent as `1.00` (dollars, 2dp — the same convention the LIVE
 *   `?pagesale` deposit uses in valor.ts). If Valor unexpectedly reads this
 *   endpoint's amount as cents, the charge is $0.01 — the mistake direction is
 *   harmless by construction. NEVER send `100` here.
 * - `surcharge: 0` + `ignore_surcharge_calc: 1` mirror the deposit flow so the
 *   charge is exactly the amount, no portal fee math on top.
 * - One shot per run, no retry, no DB writes, nothing else touched.
 * - The token value and creds are NEVER printed; the response is printed
 *   field-selectively (error_no/msg/approval_code/txnid/rrn) so an echoed
 *   token/PAN can't land in the terminal either.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const args = process.argv.slice(2);
const charge = args.includes('--charge');
const staging = args.includes('--staging');
const qi = args.indexOf('--quote');
const quoteId = qi >= 0 ? args[qi + 1] : null;

const BASE = staging
  ? 'https://securelink-staging.valorpaytech.com'
  : 'https://securelink.valorpaytech.com';

async function main() {
  if (!quoteId) throw new Error('pass --quote <quoteId> (the quote whose valor_vault_token to charge)');

  const missing = ['VALOR_APP_ID', 'VALOR_APP_KEY', 'VALOR_EPI', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error(`missing in .env.local: ${missing.join(', ')} (Valor values come from the Valor dashboard — they are Sensitive/unreadable in Vercel)`);

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: quote, error } = await sb
    .from('quotes')
    .select('id, customer_name, valor_vault_token')
    .eq('id', quoteId)
    .single<{ id: string; customer_name: string | null; valor_vault_token: string | null }>();
  if (error || !quote) throw new Error(`quote not found: ${error?.message ?? quoteId}`);
  if (!quote.valor_vault_token) throw new Error(`quote ${quoteId} has NO valor_vault_token — run a deposit with the capture armed first`);

  console.log(`quote:  ${quote.id} (${quote.customer_name ?? 'no name'})`);
  console.log(`token:  present, ${quote.valor_vault_token.length} chars (value not shown)`);
  console.log(`target: ${BASE}/?saleToken`);
  console.log(`amount: $1.00 (dollars-2dp, the pagesale convention; a cents misread = $0.01, never more)`);

  if (!charge) {
    console.log('\nDRY-RUN — nothing charged. Re-run with --charge to fire the ONE $1.00 test charge (void it in the Valor portal after).');
    return;
  }

  console.log('\nfiring ONE merchant-initiated $1.00 charge on the stored token…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/?saleToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        appid: process.env.VALOR_APP_ID,
        appkey: process.env.VALOR_APP_KEY,
        epi: process.env.VALOR_EPI,
        txn_type: 'sale',
        amount: 1.0,
        surcharge: 0,
        ignore_surcharge_calc: 1,
        token: quote.valor_vault_token,
        // First live run returned 400 D12 "SHIPPING COUNTRY MANDATORY" without
        // this — same required field the ?pagesale deposit body sends.
        shipping_country: 'US',
        invoicenumber: `mit_test_${quote.id.slice(0, 8)}`,
        orderdescription: 'YLL card-on-file reuse test — VOID ME',
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Valor request timed out after 30s (no charge confirmation — check the Valor portal before retrying)');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* keep {} — print keys below */ }
  const flat = (json.data && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : json);

  const show = (k: string) => (typeof flat[k] === 'string' || typeof flat[k] === 'number' ? flat[k] : undefined);
  console.log(`\nHTTP ${res.status}`);
  for (const k of ['error_no', 'error_code', 'msg', 'desc', 'status', 'approval_code', 'txnid', 'rrn', 'amount']) {
    const v = show(k);
    if (v !== undefined) console.log(`  ${k}: ${v}`);
  }
  console.log(`  (response keys: ${Object.keys(flat).join(', ') || 'non-JSON body, length ' + text.length})`);

  const errorNo = String(flat.error_no ?? '');
  if (res.ok && errorNo === 'S00') {
    console.log('\n✅ APPROVED — merchant-initiated token charge WORKS. VOID the $1.00 in the Valor portal now (txnid above). #83 mechanics proven.');
  } else {
    console.log('\n❌ NOT approved — read error_no/msg above. If token-invalid: likely the void killed the originating sale\'s token (retest on a non-voided one). If permission-type: API token charging may be off for our EPI — that exact code is the question for Valor.');
  }
}

main().catch(e => { console.error('ERR:', e instanceof Error ? e.message : e); process.exit(1); });
