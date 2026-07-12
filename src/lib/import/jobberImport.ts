import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { customerMatchKey, normalizeAddress, findOrCreateCustomer, findOrCreateProperty } from '@/lib/customers';
import { roundMoney } from '@/lib/money';
import { ServiceType, DEFAULT_SERVICE_TYPE, asServiceType } from '@/lib/serviceType';
import { QuoteStatus, isQuoteStatus } from '@/lib/quoteStatus';

// One-time Jobber CSV import — SCAFFOLD (ledger #72).
//
// Naldo will provide the actual Jobber export later; the exact source column
// names are UNKNOWN today. Everything in this module is column-name-agnostic
// (driven entirely by the `JobberColumnMap` the caller supplies) so the ONLY
// thing that changes once the real export shows up is filling in that map.
//
// ─── OUT OF SCOPE for this scaffold (explicit TODOs, not silently assumed) ──
//   - The actual Jobber column names (every `JobberColumnMap` field below).
//   - The service_type DETECTION RULE (holiday vs permanent vs event vs
//     permanent_bistro) — today this only recognizes an already-canonical
//     value in the mapped column; everything else falls back to
//     DEFAULT_SERVICE_TYPE at commit time. See resolveServiceType().
//   - job / invoice population — this only writes `quotes` (+ customers/
//     properties). It does NOT create `jobs` or `invoices` rows.
//   - The 6 open mapping decisions this needs before go-live:
//       1. Identity match strategy — customerMatchKey/normalizeAddress
//          (reused from src/lib/customers.ts) are the SAME rules the rest of
//          the app already uses; confirm that's still right for Jobber data
//          (e.g. does Jobber export a stable customer id we should map to
//          `sourceId` instead of relying on name/email/phone?).
//       2. Service-type detection — see resolveServiceType() above.
//       3. Timestamp field mapping — which Jobber columns are
//          customer_approved_at / quote_sent_at / deposit_paid_at, and in
//          what format (see parseTimestamp()).
//       4. Test-flag strategy — `isTest` defaults to true here so a trial
//          import is isolated + cleanable; confirm the REAL go-live import
//          should flip it to false. ⚠️ TRAP: the dedup rowKey (buildRowKey()
//          below) does NOT distinguish is_test — a trial commit's rows count
//          as "already imported" for every later commit, INCLUDING the real
//          go-live one. Clear the trial data (the existing is_test "Delete
//          test data" sweep) before running the real commit, or the go-live
//          run will silently skip every row the trial already touched.
//       5. Money precision — parseMoney()'s $/comma-stripping + roundMoney()
//          round-to-cents; confirm Jobber never exports e.g. negative
//          (refunded) totals that need different handling.
//       6. Job ↔ quote linkage — once `jobs`/`invoices` population is built,
//          decide how an imported quote links to its imported job/invoice.

// ─── Column map ─────────────────────────────────────────────────────────────

/**
 * Maps a Jobber CSV header name to each of our fields. Every slot is a
 * `string | null` — the literal column header text from the export (matched
 * against the parsed row's keys), or null while the export hasn't been seen
 * yet. planJobberImport/commitJobberImport are total no-ops on any field
 * whose map slot is null (that source data just reads as missing).
 */
export interface JobberColumnMap {
  /**
   * Jobber's own unique id for this row (Job #, Quote #, or Invoice #), if
   * the export has one. When mapped this is the STRONGEST possible dedup key
   * for commitJobberImport (a stable external id beats the composite
   * fallback derived from customer+property+total+timestamp — see
   * buildRowKey()). Safe to leave null; the fallback still gives idempotent
   * re-runs, just a slightly weaker match.
   */
  // TODO(csv): set once the Jobber export columns are known
  sourceId: string | null;

  // TODO(csv): set once the Jobber export columns are known
  customerName: string | null;
  // TODO(csv): set once the Jobber export columns are known
  customerEmail: string | null;
  // TODO(csv): set once the Jobber export columns are known
  customerPhone: string | null;
  // TODO(csv): set once the Jobber export columns are known
  propertyAddress: string | null;
  // TODO(csv): set once the Jobber export columns are known
  total: string | null;
  // TODO(csv): set once the Jobber export columns are known — see the
  // service-type DETECTION RULE note in the header comment above.
  serviceType: string | null;
  // TODO(csv): set once the Jobber export columns are known
  status: string | null;
  // TODO(csv): set once the Jobber export columns are known
  customerApprovedAt: string | null;
  // TODO(csv): set once the Jobber export columns are known
  quoteSentAt: string | null;
  // TODO(csv): set once the Jobber export columns are known
  depositPaidAt: string | null;
}

// ─── Plan types ─────────────────────────────────────────────────────────────

export type ImportRowAction = 'create-new' | 'match-existing' | 'skip';

/** One row's fully-resolved candidate — everything commitJobberImport needs
 *  to write it, computed with ZERO IO. */
export interface ImportCandidate {
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
    /** Same precedence rule as the rest of the app — customerMatchKey()
     *  (src/lib/customers.ts). */
    matchKey: string;
  };
  property: {
    address: string | null;
    /** Same rule as the rest of the app — normalizeAddress()
     *  (src/lib/customers.ts). */
    addressKey: string;
  };
  quote: {
    /** Dollars, rounded to 2dp — matches the `quotes.total numeric(10,2)`
     *  column. */
    total: number;
    /** null when the mapped column's value isn't a recognized ServiceType —
     *  commitJobberImport falls back to DEFAULT_SERVICE_TYPE. */
    serviceType: ServiceType | null;
    /** null when the mapped column's value isn't a recognized QuoteStatus —
     *  left null on write, same as any legacy row (deriveStatus() computes
     *  it from the timestamps below at read time). */
    status: QuoteStatus | null;
    customerApprovedAt: string | null;
    quoteSentAt: string | null;
    depositPaidAt: string | null;
  };
  /** The idempotency signature commitJobberImport dedups on (see
   *  buildRowKey()). */
  rowKey: string;
}

export interface ImportRowDisposition {
  rowIndex: number;
  action: ImportRowAction;
  /** Only set when action === 'skip'. */
  reason?: string;
  /** Set for every non-skip row. */
  candidate?: ImportCandidate;
}

export interface PlanJobberImportOptions {
  /** Mirrors commitJobberImport's isTest flag. The plan performs NO writes,
   *  so this is purely informational — it's echoed onto the returned
   *  ImportPlan so a dry-run preview can show what commit WOULD stamp.
   *  Defaults to true (see commitJobberImport for the isolation rationale). */
  isTest?: boolean;
}

export interface ImportPlan {
  totalRows: number;
  isTest: boolean;
  counts: {
    createNew: number;
    matchExisting: number;
    skip: number;
  };
  rows: ImportRowDisposition[];
  /** One entry per skipped row (`Row <n>: <reason>`) — a flat list for a
   *  quick admin-facing summary. */
  errors: string[];
}

// ─── Commit types ───────────────────────────────────────────────────────────

export interface CommitJobberImportOptions {
  /** Imports land as is_test=true by default (ledger #93 pattern), so a
   *  trial import is isolated from real dashboard metrics and cleanable via
   *  the existing "Delete test data" sweep. Pass false only for the real
   *  go-live commit. */
  isTest?: boolean;
}

export interface CommitRowError {
  rowIndex: number;
  error: string;
}

export interface CommitResult {
  /** Non-skipped rows the commit attempted (create-new + match-existing). */
  attempted: number;
  created: number;
  /** Already-imported rows (same rowKey found on an earlier run, or a
   *  duplicate row within this same CSV) — re-running is a no-op for these. */
  skippedExisting: number;
  failed: number;
  errors: CommitRowError[];
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

// RFC4180-style quote-aware line splitter — same algorithm as the Thunder
// wholesale-catalog parser (src/lib/inventory/parseThunderCsv.ts), kept as a
// local copy rather than importing across areas: that module's own parser is
// Thunder's FIXED positional column layout, not header-driven, so nothing
// there beyond the splitting algorithm is actually reusable. No deps.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++; // escaped ""
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parses a Jobber CSV export into header-keyed rows (`row['Column Header']`)
 * — the shape planJobberImport/JobberColumnMap expect. Blank lines are
 * skipped; a short row (fewer cells than headers) reads its missing
 * trailing cells as ''.
 */
export function parseJobberCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = splitCsvLine(raw);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    out.push(row);
  }
  return out;
}

// ─── Pure per-field helpers ─────────────────────────────────────────────────

function cell(row: Record<string, string>, col: string | null): string | null {
  if (!col) return null;
  const v = row[col];
  if (v == null) return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Money: dollars in, dollars out (2dp) — matches the `total numeric(10,2)`
// column. Strips $ and thousands separators; rejects anything that isn't a
// finite number (a blank cell, "N/A", a stray formula-error string, etc.)
// rather than ever writing NaN.
function parseMoney(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? roundMoney(n) : null;
}

// TODO(csv): confirm Jobber's actual date format before go-live (locale,
// timezone, date-only vs date+time). This is a best-effort `Date` parse that
// accepts ISO-8601 and most locale date strings today; anything it can't
// parse resolves to null (the field is simply left unset) rather than
// failing the whole row.
function parseTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// TODO(csv): the service_type DETECTION RULE is an open decision (see the
// header comment). Today this only recognizes an already-canonical value
// ('holiday' / 'permanent' / 'event' / 'permanent_bistro') in the mapped
// column; anything else resolves to null and commitJobberImport falls back
// to DEFAULT_SERVICE_TYPE.
function resolveServiceType(raw: string | null): ServiceType | null {
  return raw ? asServiceType(raw.toLowerCase()) : null;
}

// TODO(csv): confirm how Jobber's own status text maps to our QuoteStatus
// enum (see header, open decision #3 — timestamp/status mapping). Today this
// only recognizes an already-canonical value; anything else resolves to null
// and read paths fall back to deriveStatus() computing it from the
// timestamps — the SAME fallback already used for legacy/pre-migration rows.
function resolveStatus(raw: string | null): QuoteStatus | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  return isQuoteStatus(t) ? t : null;
}

// The idempotency signature a row resolves to. Prefers a mapped Jobber
// sourceId (a real external id — the strongest possible key); falls back to
// a composite of the SAME customer/property identity keys the rest of the
// app uses, plus the total and the earliest-known lifecycle timestamp. The
// composite is weaker (two genuinely different historical jobs for the same
// customer/property/total/timestamp would collide) but is the best available
// signature without a confirmed source id — see open decision #1/#6.
function buildRowKey(params: {
  sourceId: string | null;
  matchKey: string;
  addressKey: string;
  total: number;
  customerApprovedAt: string | null;
  quoteSentAt: string | null;
  depositPaidAt: string | null;
}): string {
  if (params.sourceId) return `jobber-id:${params.sourceId}`;
  const anchor = params.customerApprovedAt ?? params.quoteSentAt ?? params.depositPaidAt ?? '';
  return `composite:${params.matchKey}:${params.addressKey}:${params.total.toFixed(2)}:${anchor}`;
}

// ─── Dry-run plan (pure, no IO) ─────────────────────────────────────────────

/**
 * Resolves every row to a normalized {customer, property, quote} candidate
 * and classifies it, WITHOUT touching the database:
 *   - 'skip' — a required field is missing (no customer identity at all, or
 *     the total doesn't parse to a real number). No candidate is attached.
 *   - 'create-new' — the first row in THIS CSV to resolve to a given
 *     customer match_key.
 *   - 'match-existing' — a later row in THIS CSV resolving to a match_key
 *     already seen earlier in the same plan (a repeat customer within the
 *     batch). This is a preview only — the real DB-level dedup (against
 *     customers/properties already persisted from a PRIOR run) happens in
 *     commitJobberImport via the same findOrCreateCustomer/findOrCreateProperty
 *     helpers the rest of the app uses.
 */
export function planJobberImport(
  rows: Record<string, string>[],
  map: JobberColumnMap,
  opts: PlanJobberImportOptions = {},
): ImportPlan {
  const isTest = opts.isTest ?? true;
  const seenCustomerKeys = new Set<string>();
  const dispositions: ImportRowDisposition[] = [];
  const errors: string[] = [];
  let createNew = 0;
  let matchExisting = 0;
  let skip = 0;

  rows.forEach((row, rowIndex) => {
    const name = cell(row, map.customerName);
    const email = cell(row, map.customerEmail);
    const phone = cell(row, map.customerPhone);
    const address = cell(row, map.propertyAddress);
    const totalRaw = cell(row, map.total);
    const sourceId = cell(row, map.sourceId);

    const matchKey = customerMatchKey({ name, email, phone });
    if (!matchKey) {
      skip++;
      const reason = 'missing customer identity (name/email/phone all blank)';
      dispositions.push({ rowIndex, action: 'skip', reason });
      errors.push(`Row ${rowIndex}: ${reason}`);
      return;
    }

    const total = parseMoney(totalRaw);
    if (total === null) {
      skip++;
      const reason = `invalid or missing total ("${totalRaw ?? ''}")`;
      dispositions.push({ rowIndex, action: 'skip', reason });
      errors.push(`Row ${rowIndex}: ${reason}`);
      return;
    }

    const addressKey = normalizeAddress(address);
    const customerApprovedAt = parseTimestamp(cell(row, map.customerApprovedAt));
    const quoteSentAt = parseTimestamp(cell(row, map.quoteSentAt));
    const depositPaidAt = parseTimestamp(cell(row, map.depositPaidAt));
    const rowKey = buildRowKey({
      sourceId,
      matchKey,
      addressKey,
      total,
      customerApprovedAt,
      quoteSentAt,
      depositPaidAt,
    });

    const action: ImportRowAction = seenCustomerKeys.has(matchKey) ? 'match-existing' : 'create-new';
    seenCustomerKeys.add(matchKey);
    if (action === 'create-new') createNew++;
    else matchExisting++;

    dispositions.push({
      rowIndex,
      action,
      candidate: {
        customer: { name, email, phone, matchKey },
        property: { address, addressKey },
        quote: {
          total,
          serviceType: resolveServiceType(cell(row, map.serviceType)),
          status: resolveStatus(cell(row, map.status)),
          customerApprovedAt,
          quoteSentAt,
          depositPaidAt,
        },
        rowKey,
      },
    });
  });

  return {
    totalRows: rows.length,
    isTest,
    counts: { createNew, matchExisting, skip },
    rows: dispositions,
    errors,
  };
}

// ─── Commit (idempotent writes) ─────────────────────────────────────────────

type CandidateRow = ImportRowDisposition & { candidate: ImportCandidate };

// All-or-nothing per row: the customer + property are found-or-created
// (idempotent, race-safe — src/lib/customers.ts) and ONLY THEN is the quote
// inserted. A failure at any step returns 'failed' without a partial write;
// the customer/property found-or-created before the failure are safe to
// leave in place (find-or-create dedups them again on retry, same
// non-atomicity accepted by attachQuoteToCustomer in customers.ts).
async function commitOneRow(
  sb: SupabaseClient,
  candidate: ImportCandidate,
  isTest: boolean,
): Promise<{ status: 'created' | 'failed'; error?: string }> {
  const customer = await findOrCreateCustomer({
    name: candidate.customer.name,
    email: candidate.customer.email,
    phone: candidate.customer.phone,
  });
  if (!customer) return { status: 'failed', error: 'could not resolve customer identity' };

  const property = await findOrCreateProperty(customer.id, candidate.property.address);
  if (!property) return { status: 'failed', error: 'could not resolve property' };

  const { error } = await sb.from('quotes').insert({
    customer_name: candidate.customer.name ?? 'Anonymous',
    customer_address: candidate.property.address ?? '(no address)',
    customer_phone: candidate.customer.phone,
    customer_email: candidate.customer.email,
    customer_id: customer.id,
    property_id: property.id,
    total: candidate.quote.total,
    service_type: candidate.quote.serviceType ?? DEFAULT_SERVICE_TYPE,
    status: candidate.quote.status,
    customer_approved_at: candidate.quote.customerApprovedAt,
    quote_sent_at: candidate.quote.quoteSentAt,
    deposit_paid_at: candidate.quote.depositPaidAt,
    is_test: isTest,
    // Placeholder JSON for the NOT NULL inputs/result columns — an imported
    // row was never priced by the pricing engine, so there's no real
    // QuoteInputs/QuoteResult to store. jobberImportKey is the dedup
    // signature commitJobberImport re-checks on every run (buildRowKey()).
    inputs: { imported: true, source: 'jobber', jobberImportKey: candidate.rowKey },
    result: { imported: true, source: 'jobber', total: candidate.quote.total },
  });
  if (error) return { status: 'failed', error: error.message };
  return { status: 'created' };
}

/**
 * Applies an ImportPlan idempotently: re-running the SAME plan (or a plan
 * containing rows already committed on a prior run) writes nothing new for
 * rows it recognizes — no duplicate quotes, no duplicate customers/
 * properties (find-or-create, same as the rest of the app).
 *
 * Not safe to run concurrently with itself (a genuine simultaneous double-run
 * could race past the in-memory dedup check below) — this is a manual,
 * one-time admin action, never expected to run in parallel with itself, the
 * same accepted non-atomicity as backfillCustomersFromQuotes.
 */
export async function commitJobberImport(
  plan: ImportPlan,
  opts: CommitJobberImportOptions = {},
): Promise<CommitResult> {
  const isTest = opts.isTest ?? true;
  const candidates = plan.rows.filter((r): r is CandidateRow => r.action !== 'skip' && !!r.candidate);

  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) {
    return {
      attempted: candidates.length,
      created: 0,
      skippedExisting: 0,
      failed: candidates.length,
      errors: candidates.map((r) => ({ rowIndex: r.rowIndex, error: 'Supabase is not configured' })),
    };
  }

  // One-shot pre-fetch of every previously-imported row's dedup key, so a
  // re-run is a no-op instead of a per-row round trip. Scoped to
  // jobber-imported rows only (`inputs->>jobberImportKey is not null`) —
  // bounded, not the full quotes table.
  //
  // ⚠️ This does NOT filter by is_test — a prior TRIAL commit's rowKeys
  // still count as "already imported" here, so the real go-live commit will
  // silently skip any row a trial run already touched. Clear trial data
  // (the existing is_test "Delete test data" sweep) before the real commit.
  // See open decision #4 in the header comment.
  const existing = await sb.from('quotes').select('inputs').not('inputs->>jobberImportKey', 'is', null);
  if (existing.error) {
    return {
      attempted: candidates.length,
      created: 0,
      skippedExisting: 0,
      failed: candidates.length,
      errors: [{ rowIndex: -1, error: `Failed to read existing imports: ${existing.error.message}` }],
    };
  }
  const seenKeys = new Set<string>();
  for (const row of (existing.data ?? []) as Array<{ inputs: unknown }>) {
    const key = (row.inputs as Record<string, unknown> | null)?.jobberImportKey;
    if (typeof key === 'string') seenKeys.add(key);
  }

  let created = 0;
  let skippedExisting = 0;
  let failed = 0;
  const errors: CommitRowError[] = [];

  // Bounded-concurrency chunks (mirrors backfillCustomersFromQuotes,
  // src/lib/customers.ts CHUNK_SIZE=8) — rows are mutually independent, so
  // nothing forces strictly-serial processing, but an unbounded
  // Promise.all(candidates.map(...)) risks a large one-time import exceeding
  // a function timeout.
  const CHUNK_SIZE = 8;
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    // Reserve each key synchronously before the async work starts, so
    // duplicate rowKeys WITHIN this same chunk (e.g. a CSV with duplicate
    // rows) also collapse to a single insert instead of racing each other.
    const toCommit: CandidateRow[] = [];
    for (const row of chunk) {
      if (seenKeys.has(row.candidate.rowKey)) {
        skippedExisting++;
      } else {
        seenKeys.add(row.candidate.rowKey);
        toCommit.push(row);
      }
    }
    const results = await Promise.all(toCommit.map((row) => commitOneRow(sb, row.candidate, isTest)));
    results.forEach((res, idx) => {
      if (res.status === 'created') created++;
      else {
        failed++;
        errors.push({ rowIndex: toCommit[idx].rowIndex, error: res.error ?? 'unknown error' });
      }
    });
  }

  return { attempted: candidates.length, created, skippedExisting, failed, errors };
}
