# Operator pipeline ops console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators buttons to move a Quote → Job → Invoice through the pipeline by hand (send email/text, staff-approve, convert-to-job with a manual deposit, collect payment, close), plus consistent nav and a quote detail page — all reusing the existing #83 status machines and data layer, with no DB migration.

**Architecture:** A pure `pipelineActions(record)` core returns the legal actions for a record's current status (thin wrapper over the existing `canTransition` tables). A single `<PipelineActionsMenu>` client component fetches a record's live pipeline state (`GET /api/pipeline/[quoteId]`) and renders those actions, each hitting a thin operator route. Thin new routes reuse existing helpers (`createJobFromQuote`, `setJobStatus`, `setInvoiceStatus`) and mirror the atomic/idempotent claim patterns from the Valor webhook. Two PRs: PR1 = nav + details (no money); PR2 = the action core + routes + menu.

**Tech Stack:** Next.js 16 (App Router, `runtime = 'nodejs'`), TypeScript, Supabase service-role client, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-operator-pipeline-ops-console-design.md`

**Verified grounding (current code):**
- Quote statuses/transitions: `src/lib/quoteStatus.ts` — `canTransition`, `deriveStatus(row)`; `approved→[booked,cancelled]`.
- Job: `src/lib/jobStatus.ts` — `to_schedule→scheduled→installed→requires_invoicing→done`; `src/lib/jobs.ts` — `JobRow`, `getJob`, `getJobByQuote`, `setJobStatus` (throws on illegal, stamps `completed_at` on `done`), `createJobFromQuote` (idempotent on `quote_id`), `listJobsForAdmin`.
- Invoice: `src/lib/invoiceStatus.ts`; `src/lib/invoices.ts` — `InvoiceRow`, `getInvoice(id)`, `getInvoiceByJob`, `setInvoiceStatus` (stamps `paid_at`, does NOT zero balance), `createInvoiceFromJob`, `listInvoicesForAdmin`, `getInvoiceDetail`.
- Operator route pattern: `src/app/api/jobs/[id]/complete/route.ts` + `.../cancel/route.ts` — `requireOperator()` (dormant), `isSupabaseServiceConfigured()`, `UUID_RE`, `getSupabaseServiceClient()`.
- Atomic mark-paid pattern: `src/app/api/integrations/valor/webhook/route.ts:503-534` — `.update({status:'paid',balance:0,paid_at}).eq('id',...).neq('status','paid')` then `setJobStatus(job,'done')` when `requires_invoicing`.
- Send: `src/app/api/quotes/[id]/send/route.ts:291-330` — SMS then Email inside `if (!isGhlRetry && !quote.is_test && isHighLevelConfigured() && quote.highlevel_contact_id)`.
- Nav: `src/components/dashboard/OperatorNav.tsx:13-21` (`ITEMS`), `src/components/OperatorShell.tsx:3-12` (`OperatorArea`), `src/components/admin/BillingSubNav.tsx` (all 3 tabs). `/admin/quotes/page.tsx` does NOT mount `BillingSubNav`; jobs/invoices pages do.
- Lists/customer: `/admin/quotes/page.tsx` actions cell ~313-349 (Edit/Portal/Send/Delete, no Details); `/admin/jobs/page.tsx:170-178` + `/admin/invoices/page.tsx:162-165` have a `Detail` link; `src/app/customers/[contactId]/page.tsx:157-183` quote-history rows (single `Open` link). No `/admin/quotes/[id]/page.tsx` exists.

**Run gates (from repo root):** `npx tsc --noEmit` · `npm run lint` · `npx vitest run`. Prefix shell with `export PATH="/c/Program Files/nodejs:$PATH"`.

**Design refinement vs spec §4.3:** the menu reads live status via a lazy `GET /api/pipeline/[quoteId]` on open (Task 5) rather than enriching every list payload — same status-awareness, far less churn in the shared `listQuotes` data layer.

---

## File structure

**PR1 — `naldo/jobber-ops-nav`:**
- Modify `src/components/dashboard/OperatorNav.tsx` — add Jobs + Invoices items (Naldo area).
- Modify `src/components/OperatorShell.tsx` — add `'jobs' | 'invoices'` to `OperatorArea`.
- Modify `src/app/admin/jobs/page.tsx`, `src/app/admin/invoices/page.tsx` — pass correct `active` to OperatorShell.
- Modify `src/app/admin/quotes/page.tsx` — mount `<BillingSubNav active="quotes" />`; add a `Details` link per row.
- Create `src/app/admin/quotes/[id]/page.tsx` — read-only quote detail.

**PR2 — `naldo/jobber-ops-actions`:**
- Create `src/lib/pipeline/pipelineActions.ts` (+ `.test.ts`) — pure action core.
- Create `src/app/api/pipeline/[quoteId]/route.ts` (+ `.test.ts`) — live record read.
- Create `src/app/api/quotes/[id]/staff-approve/route.ts` (+ `.test.ts`).
- Create `src/app/api/quotes/[id]/convert-to-job/route.ts` (+ `.test.ts`).
- Modify `src/lib/invoices.ts` — add `markInvoicePaidManually`; Create `src/app/api/invoices/[id]/mark-paid/route.ts` (+ `.test.ts`).
- Create `src/app/api/jobs/[id]/close/route.ts` (+ `.test.ts`).
- Modify `src/app/api/quotes/[id]/send/route.ts` (+ its `.test.ts`) — `channel` param.
- Create `src/components/admin/PipelineActionsMenu.tsx`; mount on the 4 surfaces.

---

# PR1 — nav + details (no money)

## Task 1: Top-bar Jobs + Invoices + OperatorArea

**Files:**
- Modify: `src/components/OperatorShell.tsx:3-12`
- Modify: `src/components/dashboard/OperatorNav.tsx:13-21`
- Modify: `src/app/admin/jobs/page.tsx` (the `<OperatorShell active=...>` call), `src/app/admin/invoices/page.tsx` (same)

- [ ] **Step 1: Add `jobs`/`invoices` to `OperatorArea`.** In `OperatorShell.tsx`, extend the union:

```ts
export type OperatorArea =
  | 'home'
  | 'inbox'
  | 'insights'
  | 'quotes'
  | 'jobs'
  | 'invoices'
  | 'customers'
  | 'inventory'
  | 'new'
  | 'training'
  | 'settings';
```

- [ ] **Step 2: Add the two nav items.** In `OperatorNav.tsx` `ITEMS`, insert after the `Quotes` entry:

```ts
  { label: 'Quotes', href: '/admin/quotes', match: ['quotes', 'new'] },
  { label: 'Jobs', href: '/admin/jobs', match: ['jobs'] },
  { label: 'Invoices', href: '/admin/invoices', match: ['invoices'] },
```

- [ ] **Step 3: Point the jobs/invoices pages at their own area.** In `src/app/admin/jobs/page.tsx` change the shell wrapper to `<OperatorShell active="jobs">`; in `src/app/admin/invoices/page.tsx` to `<OperatorShell active="invoices">` (they currently pass `active="quotes"`).

- [ ] **Step 4: Gate.** Run: `npx tsc --noEmit` (expect 0) and `npm run lint` (expect 0 errors). There is no unit test for nav markup; this is a presentational change verified by tsc + a manual glance.

- [ ] **Step 5: Commit.**

```bash
git add src/components/OperatorShell.tsx src/components/dashboard/OperatorNav.tsx src/app/admin/jobs/page.tsx src/app/admin/invoices/page.tsx
git commit -m "feat(nav): add Jobs + Invoices to the operator top bar (#83 ops)"
```

## Task 2: Mount the billing strip on the quotes list

**Files:**
- Modify: `src/app/admin/quotes/page.tsx` (import + render `BillingSubNav`, matching jobs/invoices pages)

- [ ] **Step 1: Import.** Add near the other imports: `import { BillingSubNav } from '@/components/admin/BillingSubNav';`

- [ ] **Step 2: Render it.** Inside the page's `max-w-6xl` container (where `/admin/jobs/page.tsx` renders `<BillingSubNav active="jobs" />`), add `<BillingSubNav active="quotes" />` at the top of the content, replacing/adjoining the existing `← Home` link. Match the placement in `src/app/admin/jobs/page.tsx` (~line 67).

- [ ] **Step 3: Gate.** `npx tsc --noEmit` (0), `npm run lint` (0).

- [ ] **Step 4: Commit.**

```bash
git add src/app/admin/quotes/page.tsx
git commit -m "fix(admin): show the Quotes|Jobs|Invoices strip on the quotes list (#83)"
```

## Task 3: `/admin/quotes/[id]` detail page + Details links

**Files:**
- Create: `src/app/admin/quotes/[id]/page.tsx`
- Modify: `src/app/admin/quotes/page.tsx` (add a `Details` link per row)

- [ ] **Step 1: Build the detail page.** Server component modeled on `src/app/admin/jobs/[id]/page.tsx` (same `OperatorShell active="quotes"` + `<BillingSubNav active="quotes" />` + card styling). Load the quote with the same loader `src/app/quote/[id]/page.tsx` uses (`getQuoteRaw` from `src/lib/quotes.ts` — confirm the export name in that file), plus `getJobByQuote(id)` and (if a job) `getInvoiceByJob(job.id)`. Render: customer name/address, `deriveStatus(quote)` badge, the lifecycle timestamps (sent/viewed/approved/booked), line items + totals (subtotal/discount/tax/total/deposit/balance), the linked Job (link → `/admin/jobs/[jobId]`) and Invoice (link → `/admin/invoices/[invId]`) with their status badges, the `approval_snapshot.amendments` trail if present, and a `Portal ↗` link to `/portal/[id]`. Read-only — no actions here.

```tsx
// src/app/admin/quotes/[id]/page.tsx  (skeleton — match jobs/[id]/page.tsx styling)
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { getQuoteRaw } from '@/lib/quotes';
import { deriveStatus } from '@/lib/quoteStatus';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const quote = await getQuoteRaw(id);
  if (!quote) notFound();
  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  const status = deriveStatus(quote);
  return (
    <OperatorShell active="quotes">
      <div className="max-w-6xl mx-auto">
        <BillingSubNav active="quotes" />
        {/* header: customer, status badge, portal link */}
        {/* timeline: quote_sent_at / viewed_at / customer_approved_at / deposit_paid_at */}
        {/* line items + totals from quote.result */}
        {/* linked job + invoice cards with links */}
        {/* amendments trail from quote.approval_snapshot?.amendments */}
      </div>
    </OperatorShell>
  );
}
```

- [ ] **Step 2: Add a `Details` link on the quotes list.** In `src/app/admin/quotes/page.tsx` actions cell (~313-349), add a `Details` link → `/admin/quotes/${q.id}` alongside the existing buttons (label it `Details` for parity with jobs/invoices).

- [ ] **Step 3: Gate.** `npx tsc --noEmit` (0), `npm run lint` (0). Load `/admin/quotes/<a-real-id>` in the dev app and confirm it renders (manual).

- [ ] **Step 4: Commit.**

```bash
git add src/app/admin/quotes/[id]/page.tsx src/app/admin/quotes/page.tsx
git commit -m "feat(admin): read-only /admin/quotes/[id] detail page + Details links (#83)"
```

**PR1 handoff:** push `naldo/jobber-ops-nav`, open the PR, flag Jason on `OperatorShell` + the `/admin` pages, await Naldo's merge-go.

---

# PR2 — action core + routes + menu (money → adversarial review)

## Task 4: `pipelineActions()` pure core (TDD)

**Files:**
- Create: `src/lib/pipeline/pipelineActions.ts`
- Test: `src/lib/pipeline/pipelineActions.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/lib/pipeline/pipelineActions.test.ts
import { describe, it, expect } from 'vitest';
import { pipelineActions, type PipelineRecord } from './pipelineActions';

const base: PipelineRecord = { quoteId: 'q1', quoteStatus: 'draft', isTest: false, depositPaid: false };
const kinds = (r: PipelineRecord) => pipelineActions(r).map(a => a.kind);

describe('pipelineActions', () => {
  it('draft → send channels + details only', () => {
    expect(kinds(base)).toEqual(['send', 'send', 'send', 'details']);
    expect(pipelineActions(base).filter(a => a.kind === 'send').map(a => (a as {channel:string}).channel))
      .toEqual(['both', 'email', 'sms']);
  });
  it('sent/viewed → send + mark-approved + details', () => {
    for (const s of ['sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['send', 'send', 'send', 'mark-approved', 'details']);
  });
  it('changes_requested → resend + details', () => {
    expect(kinds({ ...base, quoteStatus: 'changes_requested' })).toEqual(['send', 'send', 'send', 'details']);
  });
  it('approved (unbooked) → convert-to-job + details', () => {
    expect(kinds({ ...base, quoteStatus: 'approved' })).toEqual(['convert-to-job', 'details']);
  });
  it('booked + job to_schedule → mark-complete, amend, cancel, details', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'to_schedule' } }))
      .toEqual(['mark-complete', 'amend', 'cancel', 'details']);
  });
  it('booked + requires_invoicing + unpaid invoice → collect-payment, close, amend, cancel, details', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true,
      job: { id: 'j', status: 'requires_invoicing' }, invoice: { id: 'i', status: 'awaiting_payment', balance: 500 } }))
      .toEqual(['collect-payment', 'close', 'amend', 'cancel', 'details']);
  });
  it('booked + requires_invoicing + paid invoice → close, amend, cancel, details (no collect)', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true,
      job: { id: 'j', status: 'requires_invoicing' }, invoice: { id: 'i', status: 'paid', balance: 0 } }))
      .toEqual(['close', 'amend', 'cancel', 'details']);
  });
  it('job done or cancelled → details only', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'done' } })).toEqual(['details']);
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'cancelled' } })).toEqual(['details']);
  });
  it('declined/cancelled/lost → details only', () => {
    for (const s of ['declined', 'cancelled', 'lost'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['details']);
  });
  it('details href points at the quote detail page', () => {
    const d = pipelineActions(base).find(a => a.kind === 'details');
    expect(d).toMatchObject({ kind: 'details', href: '/admin/quotes/q1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/lib/pipeline/pipelineActions.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
// src/lib/pipeline/pipelineActions.ts
import type { QuoteStatus } from '@/lib/quoteStatus';
import type { JobStatus } from '@/lib/jobStatus';
import type { InvoiceStatus } from '@/lib/invoiceStatus';

export type PipelineRecord = {
  quoteId: string;
  quoteStatus: QuoteStatus;
  isTest: boolean;
  depositPaid: boolean;
  job?: { id: string; status: JobStatus } | null;
  invoice?: { id: string; status: InvoiceStatus; balance: number } | null;
};

export type PipelineAction =
  | { kind: 'send'; channel: 'email' | 'sms' | 'both'; label: string }
  | { kind: 'mark-approved'; label: string }
  | { kind: 'convert-to-job'; label: string }
  | { kind: 'mark-complete'; label: string }
  | { kind: 'collect-payment'; label: string }
  | { kind: 'close'; label: string }
  | { kind: 'amend'; label: string }
  | { kind: 'cancel'; label: string }
  | { kind: 'details'; label: string; href: string };

function sendActions(): PipelineAction[] {
  return [
    { kind: 'send', channel: 'both', label: 'Send (email + text)' },
    { kind: 'send', channel: 'email', label: 'Send email' },
    { kind: 'send', channel: 'sms', label: 'Send text' },
  ];
}

// Legal actions for a record's current status. A pure wrapper over the #83
// status machines — it can only ever offer a move the canTransition tables allow.
export function pipelineActions(r: PipelineRecord): PipelineAction[] {
  const a: PipelineAction[] = [];

  switch (r.quoteStatus) {
    case 'draft':
      a.push(...sendActions());
      break;
    case 'sent':
    case 'viewed':
      a.push(...sendActions()); // resend
      a.push({ kind: 'mark-approved', label: 'Mark approved' });
      break;
    case 'changes_requested':
      a.push(...sendActions()); // edit + resend
      break;
    case 'approved':
      a.push({ kind: 'convert-to-job', label: 'Convert to job' });
      break;
    case 'booked': {
      const job = r.job ?? null;
      const inv = r.invoice ?? null;
      if (job && job.status !== 'done' && job.status !== 'cancelled') {
        if (job.status === 'to_schedule' || job.status === 'scheduled' || job.status === 'installed') {
          a.push({ kind: 'mark-complete', label: 'Mark installed / complete' });
        }
        if (job.status === 'requires_invoicing') {
          if (inv && inv.status !== 'paid' && inv.status !== 'cancelled') {
            a.push({ kind: 'collect-payment', label: 'Collect payment' });
          }
          a.push({ kind: 'close', label: 'Close job / invoice' });
        }
        a.push({ kind: 'amend', label: 'Amend order' });
        a.push({ kind: 'cancel', label: 'Cancel' });
      }
      break;
    }
    // declined / cancelled / lost → details only
  }

  a.push({ kind: 'details', label: 'Details', href: `/admin/quotes/${r.quoteId}` });
  return a;
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/pipeline/pipelineActions.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/pipeline/pipelineActions.ts src/lib/pipeline/pipelineActions.test.ts
git commit -m "feat(pipeline): pure status-aware pipelineActions() core (#83 ops)"
```

## Task 5: `GET /api/pipeline/[quoteId]` — live record read (TDD)

**Files:**
- Create: `src/app/api/pipeline/[quoteId]/route.ts`
- Test: `src/app/api/pipeline/[quoteId]/route.test.ts`

- [ ] **Step 1: Write the failing test.** Mock `@/lib/quotes`, `@/lib/jobs`, `@/lib/invoices`, `@/lib/auth/supabaseServer` (dormant `requireOperator` → null), `@/lib/supabase` (`isSupabaseConfigured` → true). Model on `src/app/api/jobs/[id]/route.test.ts`.

```ts
// core assertions:
// - non-UUID id → 400
// - unknown quote → 404
// - booked quote with a job + unpaid invoice → 200 body:
//   { quoteId, quoteStatus:'booked', isTest:false, depositPaid:true,
//     job:{id, status:'requires_invoicing'}, invoice:{id, status:'awaiting_payment', balance:500} }
// - approved quote, no job → job:null, invoice:null, quoteStatus:'approved'
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run src/app/api/pipeline/[quoteId]/route.test.ts`).

- [ ] **Step 3: Implement.**

```ts
// src/app/api/pipeline/[quoteId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getQuoteRaw } from '@/lib/quotes';
import { deriveStatus } from '@/lib/quoteStatus';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { quoteId } = await params;
  if (!UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }
  const quote = await getQuoteRaw(quoteId);
  if (!quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  const job = await getJobByQuote(quoteId);
  const invoice = job ? await getInvoiceByJob(job.id) : null;

  return NextResponse.json({
    quoteId,
    quoteStatus: deriveStatus(quote),
    isTest: !!quote.is_test,
    depositPaid: !!quote.deposit_paid_at,
    job: job ? { id: job.id, status: job.status } : null,
    invoice: invoice ? { id: invoice.id, status: invoice.status, balance: invoice.balance } : null,
  });
}
```

If `getQuoteRaw` doesn't select `is_test`/`deposit_paid_at`/`viewed_at`/`status`, use the loader that does (the same one `deriveStatus` callers use in `/admin/quotes/page.tsx`) — confirm the columns before finishing.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add "src/app/api/pipeline/[quoteId]/route.ts" "src/app/api/pipeline/[quoteId]/route.test.ts"
git commit -m "feat(api): GET /api/pipeline/[quoteId] live pipeline record (#83 ops)"
```

## Task 6: `POST /quotes/[id]/staff-approve` (TDD)

**Files:**
- Create: `src/app/api/quotes/[id]/staff-approve/route.ts`
- Test: `src/app/api/quotes/[id]/staff-approve/route.test.ts`

**Pattern to mirror:** `src/app/api/quotes/[id]/approve/route.ts` — it server-recomputes totals/deposit from `quote.result` (default selection via `priceSelection`) and freezes `approval_snapshot`. Staff-approve reuses that computation but **skips the signature** and marks `approval_snapshot.staffApproved`. If the approve route has an inline (non-exported) snapshot builder, extract it into a shared helper (e.g. `src/lib/quoteApproval.ts` `buildApprovalSnapshot(quote, { staff })`) and have BOTH routes call it — do not copy-paste the pricing.

- [ ] **Step 1: Write the failing test.** Mock the data layer + `requireOperator` (dormant). Assert:
  - non-UUID → 400.
  - a `draft` quote (illegal `draft→approved`) → 409.
  - a `sent` quote → 200; the update sets `status:'approved'`, `customer_approved_at` non-null, `approval_snapshot.staffApproved` present, and the write is guarded `.is('customer_approved_at', null)`.
  - a quote already `customer_approved_at` set → idempotent no-op (200 `{ alreadyApproved: true }`).
  - `is_test` quote → no real GHL/notify call fired.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Skeleton (fill the snapshot build from the approve route):

```ts
// src/app/api/quotes/[id]/staff-approve/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus, canTransition } from '@/lib/quoteStatus';
// import { buildApprovalSnapshot } from '@/lib/quoteApproval'; // extracted from approve route

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select('id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, result, approval_snapshot, is_test')
    .eq('id', id)
    .maybeSingle();
  if (!quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  if (quote.customer_approved_at) return NextResponse.json({ ok: true, alreadyApproved: true });

  const from = deriveStatus(quote);
  if (!canTransition(from, 'approved')) {
    return NextResponse.json({ error: `Cannot approve from ${from}`, code: 'illegal-transition' }, { status: 409 });
  }

  const operator = await getOperator(); // may be null while the gate is dormant
  const approvedAt = new Date().toISOString();
  // Reuse the approve route's server-recompute of the default selection + totals.
  const snapshot = {
    ...(quote.approval_snapshot ?? {}),
    // ...buildApprovalSnapshot(quote) — the frozen selection + totals, no signature
    staffApproved: { by: operator?.email ?? null, at: approvedAt },
  };

  const { data: claimed, error } = await sb
    .from('quotes')
    .update({ status: 'approved', customer_approved_at: approvedAt, approval_snapshot: snapshot })
    .eq('id', id)
    .is('customer_approved_at', null)
    .select('id');
  if (error) return NextResponse.json({ error: 'Failed to approve' }, { status: 500 });
  if (!claimed || claimed.length === 0) return NextResponse.json({ ok: true, alreadyApproved: true });

  return NextResponse.json({ ok: true, approved: true, staff: true });
}
```

- [ ] **Step 4: Run → PASS.** Then `npx tsc --noEmit` + `npm run lint`.

- [ ] **Step 5: Commit.**

```bash
git add "src/app/api/quotes/[id]/staff-approve/route.ts" "src/app/api/quotes/[id]/staff-approve/route.test.ts" src/lib/quoteApproval.ts 2>/dev/null
git commit -m "feat(api): staff-approve a quote (no e-sign, tagged) (#83 ops)"
```

## Task 7: `POST /quotes/[id]/convert-to-job` (TDD)

**Files:**
- Create: `src/app/api/quotes/[id]/convert-to-job/route.ts`
- Test: `src/app/api/quotes/[id]/convert-to-job/route.test.ts`

- [ ] **Step 1: Write the failing test.** Mock `getSupabaseServiceClient` (chainable `.update().eq().is().select()` returns `[{id}]` on the first call, `[]` on a raced second), `createJobFromQuote`, `requireOperator` (dormant). Assert:
  - non-UUID → 400; `depositUsd` missing/negative/NaN → 400.
  - approved quote, `depositUsd: 250` → 200 `{ booked:true, depositUsd:250, jobId }`; the update set `deposit_paid_at`, `deposit_amount_usd:250`, `status:'booked'`, guarded `.is('deposit_paid_at', null)`; `createJobFromQuote(id)` called once.
  - `depositUsd` greater than the quote total → clamped to the total.
  - a not-yet-approved quote (`customer_approved_at` null) → 409.
  - already-booked quote (`deposit_paid_at` set) → 200 `{ alreadyBooked:true }`, no double booking write.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**

```ts
// src/app/api/quotes/[id]/convert-to-job/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { createJobFromQuote } from '@/lib/jobs';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });

  let body: { depositUsd?: unknown } = {};
  try { body = await req.json(); } catch { body = {}; }
  const depositUsd = Number(body.depositUsd);
  if (!Number.isFinite(depositUsd) || depositUsd < 0) {
    return NextResponse.json({ error: 'depositUsd must be a number >= 0' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select('id, status, customer_approved_at, deposit_paid_at, total, is_test')
    .eq('id', id)
    .maybeSingle<{ customer_approved_at: string | null; deposit_paid_at: string | null; total: number | null }>();
  if (!quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  if (quote.deposit_paid_at) {
    const job = await createJobFromQuote(id); // idempotent
    return NextResponse.json({ ok: true, alreadyBooked: true, jobId: job?.id ?? null });
  }
  if (!quote.customer_approved_at) {
    return NextResponse.json({ error: 'Quote must be approved before converting to a job', code: 'not-approved' }, { status: 409 });
  }

  const clamped = typeof quote.total === 'number' ? Math.min(depositUsd, quote.total) : depositUsd;
  const bookedAt = new Date().toISOString();
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({ deposit_paid_at: bookedAt, deposit_amount_usd: clamped, status: 'booked' })
    .eq('id', id)
    .is('deposit_paid_at', null)
    .select('id');
  if (error) return NextResponse.json({ error: 'Failed to book the quote' }, { status: 500 });
  if (!claimed || claimed.length === 0) {
    const job = await createJobFromQuote(id);
    return NextResponse.json({ ok: true, alreadyBooked: true, jobId: job?.id ?? null });
  }

  const job = await createJobFromQuote(id); // idempotent; a test quote → a test job (#93)
  return NextResponse.json({ ok: true, booked: true, depositUsd: clamped, jobId: job?.id ?? null });
}
```

- [ ] **Step 4: Run → PASS.** Then tsc + lint.

- [ ] **Step 5: Commit.**

```bash
git add "src/app/api/quotes/[id]/convert-to-job/route.ts" "src/app/api/quotes/[id]/convert-to-job/route.test.ts"
git commit -m "feat(api): convert-to-job with a manual deposit (no Valor charge) (#83 ops)"
```

## Task 8: `markInvoicePaidManually` helper + `POST /invoices/[id]/mark-paid` (TDD)

**Files:**
- Modify: `src/lib/invoices.ts` (add the helper next to `setInvoiceStatus`)
- Test: `src/lib/invoices.test.ts` (add cases)
- Create: `src/app/api/invoices/[id]/mark-paid/route.ts`
- Test: `src/app/api/invoices/[id]/mark-paid/route.test.ts`

- [ ] **Step 1: Write the failing helper test** in `src/lib/invoices.test.ts`: `markInvoicePaidManually` on an `awaiting_payment` invoice → row with `status:'paid'`, `balance:0`, `paid_at` set; the update is atomic `.neq('status','paid')`; a `paid` invoice → idempotent (returns current, no write); a `cancelled` invoice → throws.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the helper** (mirror the webhook `handleBalancePayment` claim at `valor/webhook/route.ts:503-517`):

```ts
// add to src/lib/invoices.ts (near setInvoiceStatus)
/**
 * Manually mark an invoice paid — an operator recording an offline/external
 * payment (cash / check / paid in the Valor terminal). Atomic claim
 * (.neq('status','paid')) mirroring the Valor balance webhook: status='paid',
 * balance=0, paid_at=now. Idempotent (a paid invoice is a no-op). Throws on a
 * cancelled invoice. Does NOT touch the job — closing the job is the caller's
 * concern (the close route / collect-then-close flow).
 */
export async function markInvoicePaidManually(id: string): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const current = await getInvoice(id);
  if (!current) return null;
  if (current.status === 'cancelled') {
    throw new Error(`markInvoicePaidManually: invoice ${id} is cancelled`);
  }
  if (current.status === 'paid') return current; // idempotent no-op
  const paidAt = new Date().toISOString();
  const { data, error } = await db
    .from('invoices')
    .update({ status: 'paid', balance: 0, paid_at: paidAt })
    .eq('id', id)
    .neq('status', 'paid')
    .select(INVOICE_SELECT);
  if (error) {
    console.error('markInvoicePaidManually error:', error);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return await getInvoice(id); // raced
  return (Array.isArray(data) ? data[0] : data) as unknown as InvoiceRow;
}
```

- [ ] **Step 4: Run the helper test → PASS.**

- [ ] **Step 5: Write the failing route test** (`src/app/api/invoices/[id]/mark-paid/route.test.ts`): mock `markInvoicePaidManually` + `requireOperator`. non-UUID → 400; unknown invoice (`null`) → 404; success → 200 `{ ok:true, paid:true, invoice:{ id, status:'paid', balance:0 } }`; cancelled (helper throws) → 409.

- [ ] **Step 6: Run → FAIL.**

- [ ] **Step 7: Implement the route.**

```ts
// src/app/api/invoices/[id]/mark-paid/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { markInvoicePaidManually } from '@/lib/invoices';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });

  let invoice;
  try {
    invoice = await markInvoicePaidManually(id);
  } catch (err) {
    console.error('[api/invoices/:id/mark-paid]', err);
    return NextResponse.json({ error: 'Invoice cannot be marked paid', code: 'cancelled' }, { status: 409 });
  }
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  return NextResponse.json({
    ok: true,
    paid: true,
    invoice: { id: invoice.id, status: invoice.status, balance: invoice.balance },
  });
}
```

- [ ] **Step 8: Run → PASS.** Then tsc + lint.

- [ ] **Step 9: Commit.**

```bash
git add src/lib/invoices.ts src/lib/invoices.test.ts "src/app/api/invoices/[id]/mark-paid/route.ts" "src/app/api/invoices/[id]/mark-paid/route.test.ts"
git commit -m "feat(api): collect payment — manually mark an invoice paid (#83 ops)"
```

## Task 9: `POST /jobs/[id]/close` — finalize (TDD)

**Files:**
- Create: `src/app/api/jobs/[id]/close/route.ts`
- Test: `src/app/api/jobs/[id]/close/route.test.ts`

- [ ] **Step 1: Write the failing test.** Mock `getJob`, `getInvoiceByJob`, `markInvoicePaidManually`, `setJobStatus`, `requireOperator`. Assert:
  - non-UUID → 400; unknown job → 404; cancelled job → 400; already `done` → 200 `{ alreadyDone:true }`.
  - job `requires_invoicing` + unpaid invoice → calls `markInvoicePaidManually(inv.id)` then `setJobStatus(id,'done')`; 200 `{ closed:true }`.
  - job `requires_invoicing` + already-paid invoice → does NOT re-mark; still `setJobStatus(id,'done')`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**

```ts
// src/app/api/jobs/[id]/close/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus, type JobRow } from '@/lib/jobs';
import { getInvoiceByJob, markInvoicePaidManually } from '@/lib/invoices';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });

  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'cancelled') {
    return NextResponse.json({ error: 'Job is cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (job.status === 'done') return NextResponse.json({ ok: true, alreadyDone: true });

  // Settle the linked invoice if present + unpaid (Close = finalize).
  const invoice = await getInvoiceByJob(id);
  if (invoice && invoice.status !== 'paid' && invoice.status !== 'cancelled') {
    try {
      await markInvoicePaidManually(invoice.id);
    } catch (err) {
      console.error('[api/jobs/:id/close] settle failed:', err);
      return NextResponse.json({ error: 'Could not settle the invoice', code: 'settle-failed' }, { status: 409 });
    }
  }

  // Advance the job to done through the legal steps (installed → requires_invoicing → done).
  let current: JobRow = job;
  try {
    if (current.status === 'to_schedule' || current.status === 'scheduled') {
      current = (await setJobStatus(id, 'installed')) ?? current;
    }
    if (current.status === 'installed') {
      current = (await setJobStatus(id, 'requires_invoicing')) ?? current;
    }
    if (current.status === 'requires_invoicing') {
      await setJobStatus(id, 'done');
    }
  } catch (err) {
    const fresh = await getJob(id);
    if (!fresh || fresh.status !== 'done') {
      console.error('[api/jobs/:id/close] close race:', err);
      return NextResponse.json({ error: 'Could not close the job', code: 'close-conflict' }, { status: 409 });
    }
  }

  return NextResponse.json({ ok: true, closed: true });
}
```

- [ ] **Step 4: Run → PASS.** Then tsc + lint.

- [ ] **Step 5: Commit.**

```bash
git add "src/app/api/jobs/[id]/close/route.ts" "src/app/api/jobs/[id]/close/route.test.ts"
git commit -m "feat(api): close/finalize a job — settle invoice + job done (#83 ops)"
```

## Task 10: Send channel split (TDD)

**Files:**
- Modify: `src/app/api/quotes/[id]/send/route.ts` (parse `channel`, gate SMS/email blocks)
- Test: `src/app/api/quotes/[id]/send/route.test.ts` (add channel cases)

- [ ] **Step 1: Write the failing test.** In the existing send route test, add: with a configured HL contact (non-test), `body { channel:'sms' }` → `sendSms` called, `sendEmail` NOT called; `{ channel:'email' }` → email only; no body / `{ channel:'both' }` → both (existing behavior). Mock `sendSms`/`sendEmail` and assert call counts.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Near the top of `POST` (after `params`/body handling), parse the channel:

```ts
let sendBody: { channel?: unknown } = {};
try { sendBody = await req.json(); } catch { sendBody = {}; }
const channel: 'email' | 'sms' | 'both' =
  sendBody.channel === 'email' || sendBody.channel === 'sms' ? sendBody.channel : 'both';
const doSms = channel === 'both' || channel === 'sms';
const doEmail = channel === 'both' || channel === 'email';
```

(If the route already reads the body, extend that read instead of adding a second `req.json()` — the body can only be read once.) Then wrap the two sends (route.ts:307-329) so the SMS `try` runs only `if (doSms)` and the email `try` only `if (doEmail)`, keeping the outer `if (!isGhlRetry && !quote.is_test && isHighLevelConfigured() && quote.highlevel_contact_id)` guard. Include `channel` in the JSON response for observability.

- [ ] **Step 4: Run → PASS** (and confirm the pre-existing send tests still pass — default stays `both`). tsc + lint.

- [ ] **Step 5: Commit.**

```bash
git add "src/app/api/quotes/[id]/send/route.ts" "src/app/api/quotes/[id]/send/route.test.ts"
git commit -m "feat(api): send channel split — email / text / both (#83 ops)"
```

## Task 11: `<PipelineActionsMenu>` + mount on the 4 surfaces

**Files:**
- Create: `src/components/admin/PipelineActionsMenu.tsx`
- Modify: `src/app/admin/quotes/page.tsx`, `src/app/admin/jobs/page.tsx`, `src/app/admin/invoices/page.tsx`, `src/app/customers/[contactId]/page.tsx` (mount the menu per row)

- [ ] **Step 1: Build the component.** A client dropdown that, on open, fetches `GET /api/pipeline/${quoteId}`, runs `pipelineActions()`, and renders a button per action. Each action maps to an endpoint; `convert-to-job` prompts for a deposit (prefill the standard 50% if derivable, else blank); `cancel`/`close` confirm. On success call `onDone?.()` (the caller re-fetches / `router.refresh()`).

```tsx
// src/components/admin/PipelineActionsMenu.tsx
'use client';
import { useState } from 'react';
import Link from 'next/link';
import { pipelineActions, type PipelineRecord, type PipelineAction } from '@/lib/pipeline/pipelineActions';

async function run(action: PipelineAction, rec: PipelineRecord): Promise<Response | null> {
  const q = rec.quoteId;
  switch (action.kind) {
    case 'send':
      return fetch(`/api/quotes/${q}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: action.channel }) });
    case 'mark-approved':
      return fetch(`/api/quotes/${q}/staff-approve`, { method: 'POST' });
    case 'convert-to-job': {
      const entered = window.prompt('Deposit received (USD)? Enter 0 if none.', '');
      if (entered === null) return null;
      const depositUsd = Number(entered);
      if (!Number.isFinite(depositUsd) || depositUsd < 0) { alert('Enter a number >= 0'); return null; }
      return fetch(`/api/quotes/${q}/convert-to-job`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depositUsd }) });
    }
    case 'mark-complete':
      return rec.job ? fetch(`/api/jobs/${rec.job.id}/complete`, { method: 'POST' }) : null;
    case 'collect-payment':
      return rec.invoice ? fetch(`/api/invoices/${rec.invoice.id}/mark-paid`, { method: 'POST' }) : null;
    case 'close':
      if (!rec.job) return null;
      if (!window.confirm('Close this job/invoice? Marks it paid + done.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/close`, { method: 'POST' });
    case 'cancel':
      if (!rec.job) return null;
      if (!window.confirm('Cancel this booking? Refunds are handled manually in Valor.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/cancel`, { method: 'POST' });
    default:
      return null;
  }
}

export function PipelineActionsMenu({ quoteId, onDone }: { quoteId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [rec, setRec] = useState<PipelineRecord | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    const res = await fetch(`/api/pipeline/${quoteId}`);
    if (res.ok) setRec(await res.json());
  }

  async function onPick(action: PipelineAction) {
    if (action.kind === 'details') return; // it's a Link
    if (!rec) return;
    setBusy(true);
    try {
      const res = await run(action, rec);
      if (res && !res.ok) alert((await res.json().catch(() => ({}))).error ?? 'Action failed');
      if (res && res.ok) { setOpen(false); onDone?.(); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-block text-left">
      <button type="button" onClick={toggle} className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50">
        Options ▾
      </button>
      {open && rec && (
        <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-gray-200 bg-white shadow-lg py-1">
          {pipelineActions(rec).map((a, i) =>
            a.kind === 'details' ? (
              <Link key={i} href={a.href} className="block px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">{a.label}</Link>
            ) : (
              <button key={i} type="button" disabled={busy} onClick={() => onPick(a)}
                className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {a.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount on `/admin/quotes` rows.** In `src/app/admin/quotes/page.tsx` actions cell (~313-349) add `<PipelineActionsMenu quoteId={q.id} onDone={reload} />` (use the page's existing list-reload function; if it re-fetches on a callback, pass that). Keep the `Details` link (Task 3) or let the menu's Details cover it — keep one.
- [ ] **Step 3: Mount on `/admin/jobs` rows.** In `src/app/admin/jobs/page.tsx` (~170-178) add `<PipelineActionsMenu quoteId={j.quoteId} onDone={reload} />` for rows where `j.quoteId` exists (jobs carry `quote_id`).
- [ ] **Step 4: Mount on `/admin/invoices` rows.** In `src/app/admin/invoices/page.tsx` (~162-165) add `<PipelineActionsMenu quoteId={inv.quoteId} onDone={reload} />` (invoices carry `quote_id` — confirm the field name on the admin card type; add it to the card if missing).
- [ ] **Step 5: Mount on the customer page.** In `src/app/customers/[contactId]/page.tsx` quote-history rows (~177-179), next to `Open`, add `<PipelineActionsMenu quoteId={q.id} />`. This page is a server component — the menu is a client component, so it drops in directly; for the refresh, the menu falls back to a full reload (no `onDone` → the user re-navigates), or convert the row to a small client wrapper that calls `router.refresh()`.

- [ ] **Step 6: Gate.** `npx tsc --noEmit` (0), `npm run lint` (0), `npx vitest run` (all pass). Manually: open the menu on a draft, a booked, and a requires_invoicing record — confirm only legal actions show and each fires.

- [ ] **Step 7: Commit.**

```bash
git add src/components/admin/PipelineActionsMenu.tsx src/app/admin/quotes/page.tsx src/app/admin/jobs/page.tsx src/app/admin/invoices/page.tsx "src/app/customers/[contactId]/page.tsx"
git commit -m "feat(admin): status-aware Options menu on lists + customer page (#83 ops)"
```

## Task 12: Full gates + adversarial review (money)

- [ ] **Step 1: Full gates.** `npx tsc --noEmit` (0) · `npm run lint` (0 errors) · `npx vitest run` (all pass).
- [ ] **Step 2: Adversarial multi-agent review** (money + Jason area) focused on: double-click / retry idempotency (every mutating route's atomic claim), status-transition legality (no route can force an illegal move), `is_test` safety (no real GHL/charge on a test record), confirm NO path invokes a real Valor charge (manual paths only flip local status), and the `staff-approve`/`convert-to-job` ↔ `approval_snapshot`/amend interaction. Disposition each finding (fix / accept-with-reason / defer-to-Jason).
- [ ] **Step 3:** Fix confirmed findings; re-run gates.
- [ ] **PR2 handoff:** push `naldo/jobber-ops-actions`, open the PR, flag Jason (routes + customer/quote pages + `approval_snapshot` interaction), await Naldo's merge-go. No migration to apply.

---

## Self-review (plan vs spec)

- **Spec coverage:** nav Both → Task 1 (top bar) + Task 2 (strip). Details/new detail page → Task 3. `pipelineActions` core → Task 4. Status-aware menu everywhere → Task 5 (read) + Task 11 (menu + 4 mounts). Staff-approve → Task 6. Convert-to-job (operator deposit) → Task 7. Collect payment = mark paid → Task 8. Close = finalize → Task 9. Send email/text/both → Task 10. No migration → confirmed (Tasks 7/8/9 reuse existing columns). Adversarial review → Task 12. All spec §10 success criteria mapped.
- **Placeholder scan:** the two mirror-tasks (Task 6 snapshot build, Task 3 detail-page body) reference an exact pattern file to copy from rather than inventing — acceptable, not a blind placeholder. Everything else has literal code.
- **Type consistency:** `PipelineRecord`/`PipelineAction` defined in Task 4 are used verbatim in Tasks 5/11. `markInvoicePaidManually` defined Task 8, consumed Task 9. `channel: 'email'|'sms'|'both'` consistent across Tasks 4/10/11. Route response shapes match what the menu reads.
- **Known follow-up for the implementer:** confirm `getQuoteRaw` selects `is_test`/`deposit_paid_at`/`viewed_at`/`status`/`total`/`approval_snapshot` (Tasks 5/6/7); confirm the admin invoice card exposes `quoteId` (Task 11 Step 4).
