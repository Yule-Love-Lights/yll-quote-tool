# Wisetack Portal Financing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a portal customer finance the 50% balance of their lighting quote through Wisetack, offered at the approve/deposit step, while the Valor 50% deposit and the existing booking trigger stay unchanged.

**Architecture:** A thin Wisetack REST client isolates the third-party wire format behind a typed interface (same `CONFIRM:` pattern `src/lib/integrations/valor.ts` uses). A new `wisetack_transactions` table tracks each financing application. A customer-initiated `POST /api/quotes/[id]/finance` route creates the transaction; a signature-verified, idempotent `POST /api/integrations/wisetack/webhook` route advances its status and, on Settled, marks the balance financed. Booking stays with the existing Valor deposit-paid webhook. Everything is gated behind `WISETACK_FINANCING_ENABLED` (OFF until Naldo flips it in prod).

**Tech Stack:** Next.js (App Router, `runtime = 'nodejs'`), TypeScript, Supabase (service-role client), Vitest, Node `crypto` for webhook HMAC. Money is represented in **USD numbers** rounded with `roundMoneyGuarded` (aliased `round2`) from `@/lib/money`, matching the existing deposit/balance code.

---

## Pre-flight (executor reads first)

- **node_modules may be missing** (OneDrive eats it). Run `npm ci` before anything else.
- **Unset the empty API key** the Claude Code shell injects: before any test/dev run, `unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL` in the shell.
- **Run npm/npx through the Bash tool**, not PowerShell (PowerShell blocks `npx.ps1` on this machine).
- **Gates (run all three green after every task):**
  - `npx tsc --noEmit`
  - `npx eslint src`
  - `npx vitest run src --exclude '**/.claude/**'`
  (The `src`-scoped eslint/vitest avoid sibling-worktree pollution, per the S23 note.)
- **Branch:** already on `claude/ledger-wisetack-portal-580762`. Do not commit to `master`.
- **Ownership:** portal, quote, balance, and admin-quotes are Jason's area. This is a customer-facing money change. Jason reviews before merge; the SHARED balance/data-layer files get a heads-up to him. The `money-review` skill + an adversarial review run before merge (money-math verdict is Fable-eligible, ask-first).

## Money representation note (supersedes the spec's "integer cents" wording)

The spec said integer cents. The actual codebase represents payment-layer money as **USD numbers** with `round2`. This plan follows the codebase. The agreed total (tax-inclusive, amendment-aware) comes from `resolveAgreedTotal(approval_snapshot, result)` in `src/lib/agreedTotal.ts`. The deposit comes from `approval_snapshot.customerSelection.currentDepositUsd`. So:

```
agreedTotal = resolveAgreedTotal(approval_snapshot, result)   // USD, incl tax, honors latest amendment
deposit     = approval_snapshot.customerSelection.currentDepositUsd
balance     = round2(agreedTotal - deposit)                   // the financed amount
```

Because `resolveAgreedTotal` already honors the latest amendment, the "amend after financing" edge is mostly handled at read time; Task 3.2 adds the transaction re-issue.

---

## File Structure

**Create:**
- `src/lib/integrations/wisetack.ts`, REST client + webhook verify/parse + status mapping. Transport only, wire format isolated behind `CONFIRM:` markers. Server-only (imports `crypto`).
- `src/lib/financing/eligibility.ts`, PURE: compute financed balance + eligibility (range + service type + flag). No I/O.
- `src/lib/financing/transactions.ts`, data layer: create a transaction row, get the active one for a quote, apply a webhook status update idempotently.
- `migrations/2026-07-14-wisetack-transactions.sql`, the `wisetack_transactions` table + `financing_status` marker on `quotes`.
- `src/app/api/quotes/[id]/finance/route.ts`, customer-initiated create.
- `src/app/api/integrations/wisetack/webhook/route.ts`, status webhook.
- `src/components/portal/snowglobe/FinanceCheckout.tsx`, portal interstitial that calls `/finance` and shows the application link.
- `docs/wisetack/INTEGRATION-NOTES.md`, the P0 confirmed-API note.
- Test files alongside each (`*.test.ts`).

**Modify:**
- `src/lib/portal/loader.ts` (or `adapter.ts`), compute + expose `financingEligible` + `financeBalanceUsd` to the portal.
- `src/components/portal/snowglobe/QuoteResponseModal.tsx` and/or `src/app/portal/[quoteId]/approved/page.tsx`, render the financing CTA.
- `src/app/admin/quotes/[id]/page.tsx`, show financing status.
- `src/lib/invoices.ts` / `src/lib/balanceCollection.ts`, treat a Settled financing as balance-covered (Task 3.1).

**Shared internal types (used across tasks, keep names identical):**
```ts
// in src/lib/integrations/wisetack.ts
export type WisetackStatus =
  | 'sent' | 'started' | 'authorized' | 'accepted'
  | 'confirmed' | 'settled' | 'declined' | 'expired' | 'canceled' | 'refunded';

export const WISETACK_MIN_USD = 500;
export const WISETACK_MAX_USD = 25000;
```

---

## Phase 0: Confirm the Wisetack API surface + sandbox creds

**This phase is partly Naldo / Wisetack-side. No app code ships until it is done.** It produces one artifact: `docs/wisetack/INTEGRATION-NOTES.md`. The isolated `CONFIRM:` markers in `wisetack.ts` (Task 1.4/1.5) are the only code that depends on these answers, so P1 can be written in parallel and reconciled here.

### Task 0.1: Gather + record the confirmed API surface

**Files:**
- Create: `docs/wisetack/INTEGRATION-NOTES.md`

- [ ] **Step 1: From the Wisetack partner account / partnership manager, confirm and write down:**
  - Base URLs: sandbox and production.
  - Auth: header name + credential format (API key? bearer?).
  - Create-transaction endpoint: method, path, request body fields (amount, customer name/phone/email, external reference), response fields (transaction id, application URL).
  - Get-transaction endpoint: method, path, response status field + value casing.
  - Webhook: header names for signature + timestamp, the HMAC algorithm, and the exact signing base string.
  - Webhook payload: field carrying the transaction id, the field carrying the status, and the exact status string values.
  - Whether Wisetack texts the customer the application link automatically on create, or we present the returned URL ourselves.
  - Whether a monthly-payment estimate endpoint exists (for a "from $X/mo" display). If not, v1 shows no dollar figure.
- [ ] **Step 2: Obtain sandbox credentials** and put them in `.env.local`:
  ```
  WISETACK_API_KEY=...
  WISETACK_ENV=sandbox
  WISETACK_WEBHOOK_SECRET=...
  WISETACK_MERCHANT_ID=...        # only if the API requires it
  WISETACK_FINANCING_ENABLED=false
  ```
- [ ] **Step 3: Commit the notes doc** (creds live only in `.env.local`, never committed).
  ```bash
  git add docs/wisetack/INTEGRATION-NOTES.md
  git commit -m "docs(#154): Wisetack confirmed API surface (P0)"
  ```

---

## Phase 1: Backend (flag OFF, sandbox-tested, no UI)

### Task 1.1: Config + flag helpers

**Files:**
- Create: `src/lib/integrations/wisetack.ts` (config section only in this task)
- Test: `src/lib/integrations/wisetack.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isWisetackConfigured, isWisetackFinancingEnabled } from './wisetack';

describe('wisetack config', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.WISETACK_API_KEY; delete process.env.WISETACK_FINANCING_ENABLED; });
  afterEach(() => { process.env = { ...saved }; });

  it('isWisetackConfigured is false without an API key', () => {
    expect(isWisetackConfigured()).toBe(false);
  });
  it('isWisetackConfigured is true with an API key', () => {
    process.env.WISETACK_API_KEY = 'sk_test_x';
    expect(isWisetackConfigured()).toBe(true);
  });
  it('financing is disabled unless the flag is exactly "true"', () => {
    process.env.WISETACK_FINANCING_ENABLED = 'false';
    expect(isWisetackFinancingEnabled()).toBe(false);
    process.env.WISETACK_FINANCING_ENABLED = 'true';
    expect(isWisetackFinancingEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: FAIL ("isWisetackConfigured is not a function" / module has no exports).

- [ ] **Step 3: Write minimal implementation** (top of `src/lib/integrations/wisetack.ts`)
```ts
// Wisetack financing client (Task #154). Wraps the subset of the Wisetack API
// the portal uses: create a financing transaction for the quote BALANCE, read
// its status, and verify + parse the status webhook.
//
// ┌─ INTEGRATION CONTRACT, confirm against docs/wisetack/INTEGRATION-NOTES.md ─┐
// │ Wisetack's full API reference is behind the partner account, so the exact  │
// │ endpoints, auth header, webhook-signature base, and status strings are     │
// │ ISOLATED here and marked `CONFIRM:` (same pattern as valor.ts/highlevel.ts)│
// │ Parse defensively so a first-contact tweak is a one-line change.           │
// └────────────────────────────────────────────────────────────────────────────┘
import { createHmac, timingSafeEqual } from 'crypto';

export type WisetackStatus =
  | 'sent' | 'started' | 'authorized' | 'accepted'
  | 'confirmed' | 'settled' | 'declined' | 'expired' | 'canceled' | 'refunded';

export const WISETACK_MIN_USD = 500;
export const WISETACK_MAX_USD = 25000;

export class WisetackError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'WisetackError';
  }
}

/** True only when an API key exists. The webhook secret is checked separately in the webhook route. */
export function isWisetackConfigured(): boolean {
  return !!process.env.WISETACK_API_KEY;
}

/** The customer-facing kill switch. Financing shows/starts only when this is exactly "true". */
export function isWisetackFinancingEnabled(): boolean {
  return process.env.WISETACK_FINANCING_ENABLED === 'true';
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/integrations/wisetack.ts src/lib/integrations/wisetack.test.ts
git commit -m "feat(#154): Wisetack config + flag helpers"
```

### Task 1.2: Financed-amount + eligibility (PURE, the money math)

**Files:**
- Create: `src/lib/financing/eligibility.ts`
- Test: `src/lib/financing/eligibility.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { computeFinanceBalance, financingEligibility } from './eligibility';

const snap = (total: number, deposit: number) => ({
  customerSelection: { currentTotalUsd: total, currentDepositUsd: deposit },
});

describe('computeFinanceBalance', () => {
  it('is agreed total minus deposit, rounded to cents', () => {
    expect(computeFinanceBalance(snap(5000, 2500), { total: 5000 })).toBe(2500);
    expect(computeFinanceBalance(snap(3697.5, 1848.75), { total: 3697.5 })).toBe(1848.75);
  });
});

describe('financingEligibility', () => {
  const base = { enabled: true, serviceType: 'holiday' as const, snapshot: snap(5000, 2500), result: { total: 5000 } };

  it('eligible when flag on, holiday/permanent, balance in [500, 25000]', () => {
    expect(financingEligibility(base)).toEqual({ eligible: true, balanceUsd: 2500 });
  });
  it('not eligible when the flag is off', () => {
    expect(financingEligibility({ ...base, enabled: false }).eligible).toBe(false);
  });
  it('not eligible when balance is below the $500 floor', () => {
    const r = financingEligibility({ ...base, snapshot: snap(900, 450), result: { total: 900 } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('below_min');
  });
  it('not eligible when balance is above the $25,000 ceiling', () => {
    const r = financingEligibility({ ...base, snapshot: snap(60000, 30000), result: { total: 60000 } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('above_max');
  });
  it('not eligible for an unsupported service type', () => {
    const r = financingEligibility({ ...base, serviceType: 'permanent_bistro' as never });
    // only holiday + permanent are supported in v1
    expect(r.eligible).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/financing/eligibility.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**
```ts
import { roundMoneyGuarded as round2 } from '@/lib/money';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import type { ServiceType } from '@/lib/serviceType';
import { WISETACK_MIN_USD, WISETACK_MAX_USD } from '@/lib/integrations/wisetack';

// v1 shows financing on holiday + permanent quotes only.
const SUPPORTED: ServiceType[] = ['holiday', 'permanent'];

type Snapshot = Parameters<typeof resolveAgreedTotal>[0] & {
  customerSelection?: { currentDepositUsd?: number | null } | null;
};

/** The financed amount = agreed total (incl tax, amendment-aware) minus the deposit. USD. */
export function computeFinanceBalance(
  snapshot: Snapshot | null,
  result: { total?: number } | null,
): number {
  const agreedTotal = resolveAgreedTotal(snapshot ?? null, result ?? undefined);
  const deposit = snapshot?.customerSelection?.currentDepositUsd;
  const dep = typeof deposit === 'number' && isFinite(deposit) && deposit > 0 ? deposit : 0;
  return round2(agreedTotal - dep);
}

export type FinancingEligibility =
  | { eligible: true; balanceUsd: number }
  | { eligible: false; balanceUsd: number; reason: 'flag_off' | 'unsupported_type' | 'below_min' | 'above_max' };

export function financingEligibility(input: {
  enabled: boolean;
  serviceType: ServiceType;
  snapshot: Snapshot | null;
  result: { total?: number } | null;
}): FinancingEligibility {
  const balanceUsd = computeFinanceBalance(input.snapshot, input.result);
  if (!input.enabled) return { eligible: false, balanceUsd, reason: 'flag_off' };
  if (!SUPPORTED.includes(input.serviceType)) return { eligible: false, balanceUsd, reason: 'unsupported_type' };
  if (balanceUsd < WISETACK_MIN_USD) return { eligible: false, balanceUsd, reason: 'below_min' };
  if (balanceUsd > WISETACK_MAX_USD) return { eligible: false, balanceUsd, reason: 'above_max' };
  return { eligible: true, balanceUsd };
}
```
> NOTE: confirm `ServiceType`'s exact member names in `src/lib/serviceType.ts` before running (the test uses `holiday`/`permanent`; adjust `SUPPORTED` if the union differs). `resolveAgreedTotal`'s second arg is the pricing `result` (see `src/lib/agreedTotal.ts`).

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/lib/financing/eligibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/financing/eligibility.ts src/lib/financing/eligibility.test.ts
git commit -m "feat(#154): financed-balance + eligibility (pure)"
```

### Task 1.3: Migration, `wisetack_transactions` table + quote marker

**Files:**
- Create: `migrations/2026-07-14-wisetack-transactions.sql`

- [ ] **Step 1: Write the migration** (mirror `migrations/2026-06-24-quotes-add-valor-payment.sql` conventions)
```sql
-- Task #154, Wisetack financing on the portal.
-- Tracks a customer's financing application for a quote's BALANCE. Booking stays
-- with the Valor deposit flow; this table only records the financing lifecycle.

create table if not exists public.wisetack_transactions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  wisetack_transaction_id text unique,
  amount_usd numeric(10,2) not null,
  status text not null default 'sent',
  application_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wisetack_transactions_quote_id_idx
  on public.wisetack_transactions (quote_id);

-- Fast "is this quote financed?" read without a join, mirrored onto the quote.
alter table public.quotes add column if not exists financing_status text;

-- Service-role model (RLS enabled, no anon policy) matches every other table.
alter table public.wisetack_transactions enable row level security;
```

- [ ] **Step 2: Apply to the DEV/sandbox database** via the Supabase MCP `apply_migration` (DDL) or the browser SQL editor. Confirm the table exists:
Run (MCP `execute_sql`): `select count(*) from public.wisetack_transactions;`
Expected: `0` (table exists, empty).

- [ ] **Step 3: Regenerate DB types** if the repo tracks them (`src/lib/database.types.ts` or similar): follow the existing type-gen step. If none, skip.

- [ ] **Step 4: Commit**
```bash
git add migrations/2026-07-14-wisetack-transactions.sql
git commit -m "feat(#154): wisetack_transactions migration"
```
> Migration-first ordering (per AGENTS.md): this ships before any code that reads/writes the table.

### Task 1.4: Wisetack client, create + get transaction

**Files:**
- Modify: `src/lib/integrations/wisetack.ts`
- Test: `src/lib/integrations/wisetack.test.ts`

- [ ] **Step 1: Write the failing test** (append; mock `fetch`)
```ts
import { vi } from 'vitest';
import { createWisetackTransaction, getWisetackTransaction } from './wisetack';

describe('wisetack client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createWisetackTransaction returns transactionId + applicationUrl', async () => {
    process.env.WISETACK_API_KEY = 'sk_test_x';
    process.env.WISETACK_ENV = 'sandbox';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ transaction_id: 'wt_123', consumer_facing_url: 'https://sandbox.wisetack.com/apply/abc' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const out = await createWisetackTransaction({
      amountUsd: 2500, quoteId: 'q1', customerName: 'Jo', customerEmail: 'j@x.com', customerPhone: '+15551234567',
    });
    expect(out).toEqual({ transactionId: 'wt_123', applicationUrl: 'https://sandbox.wisetack.com/apply/abc' });
  });

  it('createWisetackTransaction throws WisetackError on non-2xx', async () => {
    process.env.WISETACK_API_KEY = 'sk_test_x';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(createWisetackTransaction({
      amountUsd: 2500, quoteId: 'q1', customerName: 'Jo', customerEmail: 'j@x.com', customerPhone: '+15551234567',
    })).rejects.toThrow(/wisetack/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Write minimal implementation** (append to `wisetack.ts`)
```ts
// CONFIRM: base URLs from docs/wisetack/INTEGRATION-NOTES.md.
function baseUrl(): string {
  return process.env.WISETACK_ENV === 'production'
    ? 'https://api.wisetack.com'          // CONFIRM
    : 'https://sandbox-api.wisetack.com'; // CONFIRM
}

// CONFIRM: auth header name + format.
function authHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${process.env.WISETACK_API_KEY}`, // CONFIRM
  };
}

// Defensive read: accept a few field-name casings so a first-contact tweak is one line.
function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) if (obj[k] != null) return obj[k] as T;
  return undefined;
}

export async function createWisetackTransaction(input: {
  amountUsd: number;
  quoteId: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
}): Promise<{ transactionId: string; applicationUrl: string }> {
  // CONFIRM: endpoint path + request body field names.
  const res = await fetch(`${baseUrl()}/v1/transactions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      transaction_amount: input.amountUsd,          // CONFIRM
      merchant_reference: input.quoteId,            // CONFIRM (echoed back on the webhook)
      customer: {                                   // CONFIRM shape
        first_name: input.customerName ?? undefined,
        email: input.customerEmail ?? undefined,
        mobile_number: input.customerPhone ?? undefined,
      },
    }),
  });
  if (!res.ok) throw new WisetackError(`Wisetack create failed (${res.status})`, res.status, await res.text().catch(() => ''));
  const body = (await res.json()) as Record<string, unknown>;
  const transactionId = pick<string>(body, ['transaction_id', 'transactionId', 'id']);
  const applicationUrl = pick<string>(body, ['consumer_facing_url', 'application_url', 'url']);
  if (!transactionId || !applicationUrl) throw new WisetackError('Wisetack create: missing id/url in response', res.status, JSON.stringify(body));
  return { transactionId, applicationUrl };
}

export async function getWisetackTransaction(transactionId: string): Promise<{ status: WisetackStatus }> {
  const res = await fetch(`${baseUrl()}/v1/transactions/${encodeURIComponent(transactionId)}`, { headers: authHeaders() }); // CONFIRM path
  if (!res.ok) throw new WisetackError(`Wisetack get failed (${res.status})`, res.status, await res.text().catch(() => ''));
  const body = (await res.json()) as Record<string, unknown>;
  const raw = pick<string>(body, ['transaction_status', 'status']) ?? 'sent';
  return { status: normalizeStatus(raw) };
}

// CONFIRM: exact status strings. Maps Wisetack's casing to our lowercase union;
// unknown values fall back to the nearest safe state.
export function normalizeStatus(raw: string): WisetackStatus {
  const s = raw.toLowerCase().trim();
  const known: WisetackStatus[] = ['sent','started','authorized','accepted','confirmed','settled','declined','expired','canceled','refunded'];
  if (known.includes(s as WisetackStatus)) return s as WisetackStatus;
  if (s === 'cancelled') return 'canceled';
  return 'sent';
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/integrations/wisetack.ts src/lib/integrations/wisetack.test.ts
git commit -m "feat(#154): Wisetack create/get transaction client"
```

### Task 1.5: Wisetack webhook verify + parse

**Files:**
- Modify: `src/lib/integrations/wisetack.ts`
- Test: `src/lib/integrations/wisetack.test.ts`

- [ ] **Step 1: Write the failing test** (append)
```ts
import { createHmac } from 'crypto';
import { verifyWisetackSignature, parseWisetackWebhook } from './wisetack';

describe('wisetack webhook', () => {
  const secret = 'whsec_test';
  const raw = JSON.stringify({ transaction_id: 'wt_123', transaction_status: 'authorized' });

  it('verifies a correct HMAC-SHA256 signature', () => {
    const sig = createHmac('sha256', secret).update(raw).digest('hex'); // CONFIRM signing base
    expect(verifyWisetackSignature(raw, sig, secret)).toBe(true);
  });
  it('rejects a forged signature', () => {
    expect(verifyWisetackSignature(raw, 'deadbeef', secret)).toBe(false);
  });
  it('parses transaction id + normalized status', () => {
    expect(parseWisetackWebhook(raw)).toEqual({ transactionId: 'wt_123', status: 'authorized' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Write minimal implementation** (append)
```ts
// CONFIRM: the exact signing base (raw body? body + timestamp?) from the notes.
export function verifyWisetackSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex'); // CONFIRM base
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseWisetackWebhook(rawBody: string): { transactionId: string; status: WisetackStatus } {
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const transactionId = pick<string>(body, ['transaction_id', 'transactionId', 'id']);
  const rawStatus = pick<string>(body, ['transaction_status', 'status']) ?? 'sent';
  if (!transactionId) throw new WisetackError('Wisetack webhook: missing transaction id');
  return { transactionId, status: normalizeStatus(rawStatus) };
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/lib/integrations/wisetack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/integrations/wisetack.ts src/lib/integrations/wisetack.test.ts
git commit -m "feat(#154): Wisetack webhook verify + parse"
```

### Task 1.6: Data layer, create / get-active / apply-webhook (idempotent)

**Files:**
- Create: `src/lib/financing/transactions.ts`
- Test: `src/lib/financing/transactions.test.ts`

- [ ] **Step 1: Write the failing test** (use an in-memory fake Supabase client so the logic is unit-tested without a DB)
```ts
import { describe, it, expect } from 'vitest';
import { applyWebhookStatus, TERMINAL_STATUSES } from './transactions';

describe('applyWebhookStatus (pure transition rules)', () => {
  it('advances to a later status', () => {
    expect(applyWebhookStatus('authorized', 'confirmed')).toEqual({ next: 'confirmed', changed: true });
  });
  it('is idempotent on a repeat of the same status', () => {
    expect(applyWebhookStatus('confirmed', 'confirmed')).toEqual({ next: 'confirmed', changed: false });
  });
  it('ignores an out-of-order regression from a terminal state', () => {
    expect(applyWebhookStatus('settled', 'authorized')).toEqual({ next: 'settled', changed: false });
  });
  it('always accepts a move INTO a terminal state', () => {
    expect(applyWebhookStatus('confirmed', 'settled')).toEqual({ next: 'settled', changed: true });
    expect(applyWebhookStatus('authorized', 'declined')).toEqual({ next: 'declined', changed: true });
  });
  it('lists the terminal statuses', () => {
    expect(TERMINAL_STATUSES).toContain('settled');
    expect(TERMINAL_STATUSES).toContain('declined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/financing/transactions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**
```ts
import { getSupabaseServiceClient } from '@/lib/supabase';
import type { WisetackStatus } from '@/lib/integrations/wisetack';

// Ordered lifecycle for the "later wins, never regress" rule.
const ORDER: WisetackStatus[] = ['sent','started','authorized','accepted','confirmed','settled'];
export const TERMINAL_STATUSES: WisetackStatus[] = ['settled','declined','expired','canceled','refunded'];
const NEGATIVE_TERMINALS: WisetackStatus[] = ['declined','expired','canceled','refunded'];

/** PURE transition: decide the row's next status for an incoming webhook status.
 *  Advances forward, is idempotent, never regresses out of a terminal state, and
 *  always accepts a move into any terminal state. */
export function applyWebhookStatus(current: WisetackStatus, incoming: WisetackStatus): { next: WisetackStatus; changed: boolean } {
  if (current === incoming) return { next: current, changed: false };
  if (TERMINAL_STATUSES.includes(current)) return { next: current, changed: false };
  if (NEGATIVE_TERMINALS.includes(incoming) || incoming === 'settled') return { next: incoming, changed: true };
  const ci = ORDER.indexOf(current);
  const ni = ORDER.indexOf(incoming);
  if (ni > ci) return { next: incoming, changed: true };
  return { next: current, changed: false };
}

export type FinancingRow = {
  id: string; quote_id: string; wisetack_transaction_id: string | null;
  amount_usd: number; status: WisetackStatus; application_url: string | null;
};

/** Create a transaction row for a quote. */
export async function createFinancingTransaction(row: {
  quoteId: string; wisetackTransactionId: string; amountUsd: number; applicationUrl: string; status: WisetackStatus;
}): Promise<void> {
  const sb = getSupabaseServiceClient()!;
  const { error } = await sb.from('wisetack_transactions').insert({
    quote_id: row.quoteId,
    wisetack_transaction_id: row.wisetackTransactionId,
    amount_usd: row.amountUsd,
    application_url: row.applicationUrl,
    status: row.status,
  });
  if (error) throw new Error(`createFinancingTransaction: ${error.message}`);
}

/** The most recent NON-terminal transaction for a quote, if any (idempotency guard for /finance). */
export async function getActiveFinancingTransaction(quoteId: string): Promise<FinancingRow | null> {
  const sb = getSupabaseServiceClient()!;
  const { data } = await sb
    .from('wisetack_transactions')
    .select('id, quote_id, wisetack_transaction_id, amount_usd, status, application_url')
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<FinancingRow>();
  if (!data) return null;
  return TERMINAL_STATUSES.includes(data.status) ? null : data;
}

/** Apply a webhook status to the stored row + mirror onto the quote. Idempotent. */
export async function applyFinancingWebhook(transactionId: string, incoming: WisetackStatus): Promise<{ changed: boolean; quoteId?: string; next?: WisetackStatus }> {
  const sb = getSupabaseServiceClient()!;
  const { data: row } = await sb
    .from('wisetack_transactions')
    .select('id, quote_id, status')
    .eq('wisetack_transaction_id', transactionId)
    .maybeSingle<{ id: string; quote_id: string; status: WisetackStatus }>();
  if (!row) return { changed: false };
  const { next, changed } = applyWebhookStatus(row.status, incoming);
  if (!changed) return { changed: false, quoteId: row.quote_id, next };
  await sb.from('wisetack_transactions').update({ status: next, updated_at: new Date().toISOString() }).eq('id', row.id);
  await sb.from('quotes').update({ financing_status: next }).eq('id', row.quote_id);
  return { changed: true, quoteId: row.quote_id, next };
}
```
> The pure `applyWebhookStatus` carries the idempotency + no-regress rules and is fully unit-tested in Step 1. The DB wrappers are thin; their integration coverage comes from the route tests (Task 1.8) and the sandbox E2E (Phase 4).

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/lib/financing/transactions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/financing/transactions.ts src/lib/financing/transactions.test.ts
git commit -m "feat(#154): financing transactions data layer + transition rules"
```

### Task 1.7: `POST /api/quotes/[id]/finance`

**Files:**
- Create: `src/app/api/quotes/[id]/finance/route.ts`
- Test: `src/app/api/quotes/[id]/finance/route.test.ts`

Mirror `src/app/api/quotes/[id]/pay/route.ts`: rate limit, `isSupabaseServiceConfigured`, `UUID_RE`, service-role fetch, `deriveStatus` dead-quote guard, then create the Wisetack transaction and store the row.

- [ ] **Step 1: Write the failing test** (mock `@/lib/integrations/wisetack`, `@/lib/financing/*`, and the Supabase client, following the shape of `pay/route.test.ts`)
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/integrations/wisetack', () => ({
  isWisetackConfigured: () => true,
  isWisetackFinancingEnabled: () => true,
  createWisetackTransaction: vi.fn(async () => ({ transactionId: 'wt_1', applicationUrl: 'https://apply/x' })),
  WISETACK_MIN_USD: 500, WISETACK_MAX_USD: 25000,
}));
// ...mock supabase + financing/eligibility + financing/transactions similarly...

describe('POST /finance', () => {
  beforeEach(() => vi.clearAllMocks());
  it('400 on a bad quote id', async () => { /* call POST with id="x" → expect 400 */ });
  it('503 when financing is disabled (flag off)', async () => { /* flag off → 503 code:"financing-disabled" */ });
  it('409 when the quote is not approved', async () => { /* no approval_snapshot → 409 code:"approve-first" */ });
  it('422 when the balance is out of Wisetack range', async () => { /* balance 100 → 422 code:"out-of-range" */ });
  it('returns the existing active transaction instead of creating a duplicate', async () => { /* getActiveFinancingTransaction returns a row → applicationUrl echoed, createWisetackTransaction NOT called */ });
  it('creates a transaction + returns applicationUrl on the happy path', async () => { /* → { ok:true, applicationUrl } and createFinancingTransaction called once */ });
});
```
> Fill each test body against `pay/route.test.ts`'s existing mock scaffolding (same Supabase mock + request helper). Keep the assertions above exactly.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/app/api/quotes/[id]/finance/route.test.ts`
Expected: FAIL (route not found).

- [ ] **Step 3: Write the implementation**
```ts
import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { deriveStatus } from '@/lib/quoteStatus';
import { isWisetackConfigured, isWisetackFinancingEnabled, createWisetackTransaction, WISETACK_MIN_USD, WISETACK_MAX_USD } from '@/lib/integrations/wisetack';
import { computeFinanceBalance } from '@/lib/financing/eligibility';
import { createFinancingTransaction, getActiveFinancingTransaction } from '@/lib/financing/transactions';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  const rl = rateLimitResponse(req, { bucket: 'quote-finance', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });

  if (!isWisetackFinancingEnabled() || !isWisetackConfigured()) {
    return NextResponse.json({ error: 'Financing is not available', code: 'financing-disabled' }, { status: 503 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error } = await sb
    .from('quotes')
    .select('id, customer_name, customer_email, customer_phone, customer_approved_at, deposit_paid_at, approval_snapshot, result, status, is_test')
    .eq('id', id)
    .single<{
      id: string; customer_name: string | null; customer_email: string | null; customer_phone: string | null;
      customer_approved_at: string | null; deposit_paid_at: string | null;
      approval_snapshot: { customerSelection?: { currentDepositUsd?: number } } | null;
      result: { total?: number } | null;
      status: import('@/lib/quoteStatus').QuoteStatus | null; is_test: boolean;
    }>();
  if (error || !quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  if (quote.is_test) return NextResponse.json({ error: 'Test quote: financing is skipped', code: 'test-quote' }, { status: 400 });
  if (!quote.customer_approved_at || !quote.approval_snapshot) {
    return NextResponse.json({ error: 'Quote must be approved first', code: 'approve-first' }, { status: 409 });
  }

  const lifecycle = deriveStatus({ quote_sent_at: null, customer_approved_at: quote.customer_approved_at, deposit_paid_at: quote.deposit_paid_at, status: quote.status });
  if (lifecycle === 'cancelled' || lifecycle === 'declined' || lifecycle === 'lost') {
    return NextResponse.json({ error: `This quote is ${lifecycle}`, code: 'not-financeable' }, { status: 409 });
  }

  const balanceUsd = computeFinanceBalance(quote.approval_snapshot, quote.result);
  if (balanceUsd < WISETACK_MIN_USD || balanceUsd > WISETACK_MAX_USD) {
    return NextResponse.json({ error: 'Balance is outside the financing range', code: 'out-of-range' }, { status: 422 });
  }

  // Idempotency: reuse an in-flight application instead of minting a duplicate.
  const active = await getActiveFinancingTransaction(id);
  if (active?.application_url) {
    return NextResponse.json({ ok: true, applicationUrl: active.application_url, amountUsd: active.amount_usd, reused: true });
  }

  try {
    const { transactionId, applicationUrl } = await createWisetackTransaction({
      amountUsd: balanceUsd, quoteId: id,
      customerName: quote.customer_name, customerEmail: quote.customer_email, customerPhone: quote.customer_phone,
    });
    await createFinancingTransaction({ quoteId: id, wisetackTransactionId: transactionId, amountUsd: balanceUsd, applicationUrl, status: 'sent' });
    return NextResponse.json({ ok: true, applicationUrl, amountUsd: balanceUsd });
  } catch (err) {
    console.error('[api/quotes/:id/finance] create failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Could not start financing. Please try again.', code: 'wisetack-failed' }, { status: 502 });
  }
}
```
> CONFIRM `quotes` has a `customer_phone` column; if it lives elsewhere (adapter maps `PortalQuote.customer.phone` per the PDF task #87), read it from there. `result` is the pricing result JSON already stored on the quote.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/app/api/quotes/[id]/finance/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all gates + commit**
```bash
npx tsc --noEmit && npx eslint src && npx vitest run src --exclude '**/.claude/**'
git add src/app/api/quotes/[id]/finance/
git commit -m "feat(#154): POST /finance route (flag-gated, idempotent)"
```

### Task 1.8: `POST /api/integrations/wisetack/webhook`

**Files:**
- Create: `src/app/api/integrations/wisetack/webhook/route.ts`
- Test: `src/app/api/integrations/wisetack/webhook/route.test.ts`

Mirror `src/app/api/integrations/valor/webhook/route.ts`: read the RAW body, verify the signature, parse, then apply the status. **Never books the quote.**

- [ ] **Step 1: Write the failing test**
```ts
// - 401 when the signature is missing/forged
// - 200 + no-op when WISETACK_WEBHOOK_SECRET is unset (mirror valor: fail safe, log)
// - 200 + applyFinancingWebhook called with (transactionId, status) on a valid signed body
// - duplicate delivery → applyFinancingWebhook reports changed:false, still 200
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/app/api/integrations/wisetack/webhook/route.test.ts`
Expected: FAIL (route not found).

- [ ] **Step 3: Write the implementation**
```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyWisetackSignature, parseWisetackWebhook } from '@/lib/integrations/wisetack';
import { applyFinancingWebhook } from '@/lib/financing/transactions';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secret = process.env.WISETACK_WEBHOOK_SECRET;
  const raw = await req.text();
  // CONFIRM: header name for the signature.
  const signature = req.headers.get('wisetack-signature');

  if (!secret) {
    // Not configured yet, accept + no-op so retries don't storm (mirror valor).
    console.warn('[wisetack/webhook] WISETACK_WEBHOOK_SECRET unset; ignoring event');
    return NextResponse.json({ ok: true, ignored: 'unconfigured' });
  }
  if (!verifyWisetackSignature(raw, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let parsed;
  try { parsed = parseWisetackWebhook(raw); }
  catch { return NextResponse.json({ error: 'Bad payload' }, { status: 400 }); }

  const result = await applyFinancingWebhook(parsed.transactionId, parsed.status);
  // Reconciliation on Settled is handled in Task 3.1 (reads financing_status).
  return NextResponse.json({ ok: true, changed: result.changed });
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/app/api/integrations/wisetack/webhook/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all gates + commit**
```bash
npx tsc --noEmit && npx eslint src && npx vitest run src --exclude '**/.claude/**'
git add src/app/api/integrations/wisetack/
git commit -m "feat(#154): Wisetack status webhook (signature-verified, idempotent)"
```

**Phase 1 checkpoint:** backend complete, flag OFF, all gates green. Sandbox-probe `createWisetackTransaction` + a signed webhook against the sandbox before P2 (Phase 4 has the full E2E).

---

## Phase 2: Portal + operator UI

### Task 2.1: Expose eligibility to the portal

**Files:**
- Modify: `src/lib/portal/loader.ts` (or `src/lib/portal/adapter.ts` where `customerSelection`/`currentTotalUsd` already map)
- Test: extend the loader's existing test

- [ ] **Step 1: Add a failing test** asserting the loaded portal object carries `financing: { eligible, balanceUsd }` computed via `financingEligibility({ enabled: isWisetackFinancingEnabled(), serviceType, snapshot, result })`.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement**, call `financingEligibility(...)` in the loader and attach `financing` to the returned portal model. Keep it server-side so the flag never ships to the client.
- [ ] **Step 4: Gates green.**
- [ ] **Step 5: Commit** `feat(#154): expose financing eligibility to the portal`.

### Task 2.2: `FinanceCheckout` component + CTA

**Files:**
- Create: `src/components/portal/snowglobe/FinanceCheckout.tsx` (mirror `DepositCheckout.tsx`: interstitial → POST → show the returned `applicationUrl` as a "Continue to Wisetack" link; friendly errors)
- Modify: `src/components/portal/snowglobe/QuoteResponseModal.tsx` and/or `src/app/portal/[quoteId]/approved/page.tsx`, render "Finance the 50% balance monthly with Wisetack" as a secondary option when `financing.eligible`, presented at approve and kicked off from the post-deposit `/approved` page.

- [ ] **Step 1:** Test `FinanceCheckout` renders the interstitial, POSTs to `/api/quotes/[id]/finance`, and renders the `applicationUrl` link on success (React Testing Library, mirror `DepositCheckout` tests).
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement the component + wire the CTA behind `financing.eligible`.
- [ ] **Step 4:** Add a `track('financing_started', { quote_id, service_type })` PostHog event (align with the existing `approve_error` pattern in `DepositCheckout`).
- [ ] **Step 5:** Gates green; commit `feat(#154): portal financing CTA + FinanceCheckout`.

### Task 2.3: Financed state on `/approved`

**Files:**
- Modify: `src/app/portal/[quoteId]/approved/page.tsx`

- [ ] Show a "Financing in progress / approved" banner keyed off `financing_status` (none → hide; authorized/confirmed → in progress; settled → done; declined/expired → "pay the balance the usual way"). Test the banner mapping. Gates green; commit.

### Task 2.4: Operator financing status

**Files:**
- Modify: `src/app/admin/quotes/[id]/page.tsx`

- [ ] Surface `financing_status` + `amount_usd` from the latest `wisetack_transactions` row in the operator quote view. Test the read. Gates green; commit `feat(#154): operator financing status on /admin/quotes/[id]`.

**Phase 2 checkpoint:** Naldo device-reviews the portal CTA + copy on a real is_test quote before P3.

---

## Phase 3: Balance reconciliation + edges

### Task 3.1: A Settled financing covers the balance

**Files:**
- Modify: `src/lib/invoices.ts` and/or `src/lib/balanceCollection.ts`
- Test: extend `src/lib/invoices.test.ts` / `balanceCollection.test.ts`

- [ ] **Step 1:** Failing test: when a quote's `financing_status === 'settled'`, the balance-collection plan is `{ method: 'none', reason: 'financed' }` (add `'financed'` to the `no_balance`/`overpaid` reason union) and the invoice shows the balance as covered-by-financing, not owed via Valor.
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement, thread a `financingSettled` boolean into `planBalanceCollection` (or its caller) so a settled financing short-circuits to `none/financed`. Keep the function pure; the caller reads `financing_status`.
- [ ] **Step 4:** Gates green.
- [ ] **Step 5:** Commit `feat(#154): settled financing covers the invoice balance`.
> SHARED file (`invoices.ts`/`balanceCollection.ts`), heads-up to Jason before merge.

### Task 3.2: Decline / expire / refund + amend re-issue

**Files:**
- Modify: `src/lib/financing/transactions.ts`, `src/app/api/quotes/[id]/amend/route.ts`
- Test: `src/lib/financing/transactions.test.ts`, amend route test

- [ ] **Decline/expire/canceled:** already handled, `financing_status` goes terminal-negative, `getActiveFinancingTransaction` returns null (so the customer can retry) and the balance stays collectable by Valor. Add a test asserting a declined quote's balance plan is unchanged (still Valor). Commit.
- [ ] **Amend after financing:** in the amend route, if a non-terminal `wisetack_transactions` row exists, void it (call Wisetack cancel if the API supports it, CONFIRM, else mark it `canceled` locally) so the financed amount can never disagree with the re-priced total. Add a test. Commit `fix(#154): amend voids an in-flight financing application`.

---

## Phase 4: Sandbox E2E, then go-live

### Task 4.1: Full sandbox E2E

- [ ] With `WISETACK_ENV=sandbox` and the flag ON locally: create a real is_test-style quote, approve it, pay the deposit (simulate), start financing, and drive the Wisetack sandbox transaction through Authorized → Accepted → Confirmed → Settled, confirming each webhook advances `financing_status` and Settled flips the balance to financed. Record the run in `docs/wisetack/INTEGRATION-NOTES.md`.
- [ ] Reconcile every `CONFIRM:` marker in `wisetack.ts` against the real sandbox behavior; fix any wire-format drift (one-liners by design).

### Task 4.2: Prod go-live (Naldo)

- [ ] Apply the migration to prod (Supabase MCP `apply_migration` / browser SQL editor).
- [ ] Set the prod env in Vercel: `WISETACK_API_KEY`, `WISETACK_ENV=production`, `WISETACK_WEBHOOK_SECRET`, `WISETACK_MERCHANT_ID` (if needed), `WISETACK_FINANCING_ENABLED=false`. Register the prod webhook URL in the Wisetack merchant portal.
- [ ] Merge (Jason's go + a human merge-go per policy). Deploy, SHA-verify.
- [ ] Flip `WISETACK_FINANCING_ENABLED=true` in prod, redeploy so it applies, and live-verify on an is_test quote end-to-end.
- [ ] Rollback lever: set `WISETACK_FINANCING_ENABLED=false` (instant) or revert the PR.

---

## Self-Review

**Spec coverage:**
- Money = balance (total − deposit): Task 1.2 (`computeFinanceBalance`), reconciles on partials via `resolveAgreedTotal`. ✅
- $500–$25,000 gate on the balance: Task 1.2 + Task 1.7. ✅
- Booking trigger unchanged: no task touches the Valor deposit-paid webhook; Task 1.8 explicitly never books. ✅
- Full API (create + status webhook): Tasks 1.4, 1.5, 1.7, 1.8. ✅
- Both verticals: Task 1.2 `SUPPORTED = ['holiday','permanent']`. ✅
- Kill switch: Task 1.1 flag, enforced in 1.7 + gated in 2.1. ✅
- Idempotency + signature verify: Tasks 1.5, 1.6, 1.8. ✅
- Portal CTA at approve/deposit: Tasks 2.1–2.3. ✅
- Operator status: Task 2.4. ✅
- Balance reconciliation + decline fallback + amend: Task 3.1, 3.2. ✅
- Sandbox-first + flag-off-until-flip: Phase 4. ✅
- Out of scope (in-tool completion trigger, full-ticket financing): not planned. ✅

**Placeholder scan:** the only deferred specifics are the `CONFIRM:` wire-format markers, which are intentional and reconciled in Task 4.1 against the P0 notes. No TODO/TBD tasks.

**Type consistency:** `WisetackStatus`, `WISETACK_MIN_USD/MAX_USD`, `computeFinanceBalance`, `financingEligibility`, `createWisetackTransaction`, `getWisetackTransaction`, `normalizeStatus`, `verifyWisetackSignature`, `parseWisetackWebhook`, `applyWebhookStatus`, `createFinancingTransaction`, `getActiveFinancingTransaction`, `applyFinancingWebhook`, and the `financing_status` column name are used identically across every task.

**Money-feature guardrails:** test-first throughout; the pure money math (1.2) and transition rules (1.6) are unit-tested before any I/O; sandbox E2E before prod; flag OFF until Naldo flips it; `money-review` skill + adversarial review before merge (money-math verdict Fable-eligible); Jason reviews (his area + SHARED files).
