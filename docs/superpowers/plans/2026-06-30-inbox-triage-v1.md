# Inbox triage v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/inbox` dashboard triage real customers fast — a top "at-a-glance" strip, channel filter tiles, an oldest-waiting-first list with enriched cards, and noise filtering that hides our own alerts + automated/marketing mail.

**Architecture:** Two new nullable columns on `inbox_items` (`lead_kind`, `quote_value`) set at ingest by a pure classifier; the reducer state machine is untouched. The open-items query gains the columns + flips to oldest-first. The summary strip, channel filters, and "show filtered" toggle are pure client logic over the already-polled item list — no new server metrics plumbing. The self-ingest loop is fixed by widening the Gmail "from us" check from a single address to our whole domain.

**Tech Stack:** Next.js (server + client components), TypeScript, Supabase (service-role writes), Vitest. Run gates from the worktree: `npx tsc --noEmit`, `npm run lint`, `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-30-inbox-triage-v1-design.md`

**Scope refinements from planning (confirm before execution):**
- **Layer 3 ("Not a lead" learns the sender) → v2.** Layers 1+2 catch every noise example observed. The manual "Not a lead" button already permanently dismisses a conversation (sticky in the reducer); cross-conversation sender-suppression is deferred.
- **New-vs-returning uses a history proxy** (`contact has >1 inbox_items`), not the dormant `quote_customer_id` column.

---

## File map

**Create:**
- `migrations/2026-06-30-inbox-lead-classification.sql` — the two new columns
- `src/lib/dashboard/inbox/classify.ts` — pure classifier (`classifyMessage`, `isFromUs`)
- `src/lib/dashboard/inbox/classify.test.ts`
- `src/lib/dashboard/inbox/summary.ts` — pure `buildInboxSummary` for the strip
- `src/lib/dashboard/inbox/summary.test.ts`
- `src/components/dashboard/inbox/InboxSummaryStrip.tsx` — presentational metric tiles
- `src/app/inbox/settings/page.tsx` — stub settings page (the gear target)

**Modify:**
- `src/lib/dashboard/inbox/types.ts` — `NormalizedTouch` + `OpenInboxItem` gain fields
- `src/lib/dashboard/inbox/gmail.ts` — widen "from us" to domain; carry `hasListUnsubscribe`; set `leadKind`
- `src/lib/dashboard/inbox/ghl.ts` — set `leadKind` from preview/subject
- `src/lib/dashboard/inbox/quotetool.ts` — set `leadKind: 'lead'`, `quoteValue: q.total`
- `src/lib/dashboard/inbox/sync.ts` — thread our-domain/internal-froms into `runGmailPoll`
- `src/lib/dashboard/inbox/store.ts` — `ItemRow` + `planIngest` + `listOpenItems` (select, mapper, sort, returning-proxy)
- `src/components/dashboard/inbox/InboxList.tsx` — strip, filter tiles, "show filtered" toggle, enriched cards

---

## Task 1: Migration — `lead_kind` + `quote_value` columns

**Files:**
- Create: `migrations/2026-06-30-inbox-lead-classification.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Inbox triage v1 (#58) — two additive, nullable columns on inbox_items.
--   lead_kind   : 'lead' | 'automated'  (NULL = unclassified, treated as 'lead')
--   quote_value : the quote $ total for quotetool items (NULL elsewhere)
-- Additive + nullable → no backfill, no default-state churn. RLS already covers
-- the table. Apply out-of-band (Supabase SQL editor) when a human approves.

begin;

alter table public.inbox_items
  add column if not exists lead_kind   text,
  add column if not exists quote_value numeric;

-- Open-list filter is (status='unresponded' AND lead_kind …); this index serves it.
create index if not exists inbox_items_status_lead_kind_idx
  on public.inbox_items (status, lead_kind, last_message_at desc);

commit;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/2026-06-30-inbox-lead-classification.sql
git commit -m "feat(#58): migration — inbox_items.lead_kind + quote_value"
```

> Note: applying to prod is human-gated (Chrome + Supabase SQL editor, per `project_apply_migrations_via_browser`). Code reads these columns defensively (NULL = lead), so the code can ship before the migration is applied without breaking the open list.

---

## Task 2: Pure classifier — `classifyMessage` + `isFromUs`

**Files:**
- Create: `src/lib/dashboard/inbox/classify.ts`
- Test: `src/lib/dashboard/inbox/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { classifyMessage, isFromUs } from './classify';

describe('isFromUs', () => {
  const opts = { ourDomain: 'yulelovelights.com', internalAddrs: ['sales@yulelovelights.com'] };
  it('matches our domain', () => {
    expect(isFromUs('anyone@yulelovelights.com', opts)).toBe(true);
  });
  it('matches an explicit internal address regardless of domain', () => {
    expect(isFromUs('sales@yulelovelights.com', opts)).toBe(true);
  });
  it('rejects an outside address', () => {
    expect(isFromUs('customer@gmail.com', opts)).toBe(false);
  });
  it('is null-safe', () => {
    expect(isFromUs(null, opts)).toBe(false);
  });
});

describe('classifyMessage', () => {
  it('flags a List-Unsubscribe message as automated', () => {
    expect(classifyMessage({ fromAddress: 'news@getjobber.com', subject: 'Last day', preview: 'Grab a $499 ticket', hasListUnsubscribe: true })).toBe('automated');
  });
  it('flags a no-reply sender as automated', () => {
    expect(classifyMessage({ fromAddress: 'no-reply@notify.example.com', subject: 'Receipt', preview: 'x' })).toBe('automated');
  });
  it('flags unsubscribe language in the preview as automated', () => {
    expect(classifyMessage({ fromAddress: 'info@vendor.com', subject: 'Hi', preview: "you just called us... If you no longer wish to receive these emails" })).toBe('automated');
  });
  it('flags SMS opt-out language as automated', () => {
    expect(classifyMessage({ fromAddress: null, subject: null, preview: 'Sale ends today! Reply STOP to opt out' })).toBe('automated');
  });
  it('treats a normal customer message as a lead', () => {
    expect(classifyMessage({ fromAddress: 'jane@gmail.com', subject: 'Quote question', preview: 'How much for my roofline?' })).toBe('lead');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/dashboard/inbox/classify.test.ts`
Expected: FAIL — `classify.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// Pure lead-vs-noise classification (#58 inbox triage v1). No I/O — adapters call
// this with the signals they have, then stamp NormalizedTouch.leadKind. Layer 1
// (from-us, by domain) is handled in the Gmail adapter's direction logic; this
// module is layer 2 (automated/marketing) + the shared isFromUs helper.

export type LeadKind = 'lead' | 'automated';

const NO_REPLY_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer|bounce|postmaster)@/i;
const AUTOMATED_PHRASES = [
  'unsubscribe',
  'no longer wish to receive',
  'opt out',
  'opt-out',
  'reply stop',
  'manage your preferences',
  'manage preferences',
];

/** Bare lowercased address out of a "Name <addr>" or bare string. */
function bareAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const angle = value.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

export function isFromUs(
  fromAddress: string | null | undefined,
  opts: { ourDomain?: string | null; internalAddrs?: string[] },
): boolean {
  const addr = bareAddress(fromAddress);
  if (!addr) return false;
  const domain = opts.ourDomain?.trim().toLowerCase();
  if (domain && addr.endsWith(`@${domain}`)) return true;
  return (opts.internalAddrs ?? []).some((a) => bareAddress(a) === addr);
}

export function classifyMessage(input: {
  fromAddress?: string | null;
  subject?: string | null;
  preview?: string | null;
  hasListUnsubscribe?: boolean;
}): LeadKind {
  if (input.hasListUnsubscribe) return 'automated';
  const addr = bareAddress(input.fromAddress);
  if (addr && NO_REPLY_RE.test(addr)) return 'automated';
  const haystack = `${input.subject ?? ''} ${input.preview ?? ''}`.toLowerCase();
  if (AUTOMATED_PHRASES.some((p) => haystack.includes(p))) return 'automated';
  return 'lead';
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/lib/dashboard/inbox/classify.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/inbox/classify.ts src/lib/dashboard/inbox/classify.test.ts
git commit -m "feat(#58): pure lead-vs-automated classifier"
```

---

## Task 3: Layer 1 — widen Gmail "from us" to our domain (self-ingest fix)

**Files:**
- Modify: `src/lib/dashboard/inbox/gmail.ts` (`gmailMessageFromMe` at lines 96-101; callers at 108, 117)
- Modify: `src/lib/dashboard/inbox/sync.ts` (`runGmailPoll`, the `ourEmail` at line 173 + `mapGmailThread` call at 191)
- Test: `src/lib/dashboard/inbox/gmail.test.ts` (extend)

- [ ] **Step 1: Add the failing test** (append to `gmail.test.ts`)

```ts
import { mapGmailThread } from './gmail';

it('treats any sender on our domain as from-us (kills the escalation self-ingest)', () => {
  const raw = {
    id: 't1',
    messages: [
      { id: 'm1', labelIds: ['INBOX'], internalDate: '1000',
        payload: { headers: [{ name: 'From', value: 'Yule Love Lights <sales@yulelovelights.com>' }, { name: 'Subject', value: 'URGENT: 28 customer messages still unanswered' }] } },
    ],
  };
  const thread = mapGmailThread(raw, { ourEmail: 'info@yulelovelights.com', ourDomain: 'yulelovelights.com', internalAddrs: ['sales@yulelovelights.com'] });
  expect(thread.messages[0].fromMe).toBe(true);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/dashboard/inbox/gmail.test.ts`
Expected: FAIL — `mapGmailThread`'s 2nd arg is currently a `string` (`ourEmail`), so `{...}` won't compile / the domain isn't matched.

- [ ] **Step 3: Change `gmailMessageFromMe` + `mapGmailThread` to take an identity object**

In `gmail.ts`, replace the current function (lines 96-101):

```ts
export function gmailMessageFromMe(m: RawGmailMessage, ourEmail: string): boolean {
  if (m.labelIds?.includes('SENT')) return true;
  const from = getHeader(m, 'From');
  const addr = from ? parseEmailAddress(from) : null;
  return addr !== null && addr === ourEmail.trim().toLowerCase();
}
```

with:

```ts
export type GmailIdentity = { ourEmail: string; ourDomain?: string | null; internalAddrs?: string[] };

export function gmailMessageFromMe(m: RawGmailMessage, identity: GmailIdentity): boolean {
  if (m.labelIds?.includes('SENT')) return true;
  const from = getHeader(m, 'From');
  const addr = from ? parseEmailAddress(from) : null;
  if (!addr) return false;
  if (addr === identity.ourEmail.trim().toLowerCase()) return true;
  if (identity.ourDomain && addr.endsWith(`@${identity.ourDomain.trim().toLowerCase()}`)) return true;
  return (identity.internalAddrs ?? []).some((a) => a.trim().toLowerCase() === addr);
}
```

Update the two callers inside `mapGmailThread` — change the signature `mapGmailThread(raw: RawGmailThread, ourEmail: string)` to `mapGmailThread(raw: RawGmailThread, identity: GmailIdentity)`, and replace `gmailMessageFromMe(m, ourEmail)` (lines 108, 117) with `gmailMessageFromMe(m, identity)`.

- [ ] **Step 4: Thread the identity through `runGmailPoll`**

In `sync.ts`, replace `const ourEmail = process.env.GMAIL_USER || 'me';` (line 173) with:

```ts
const ourEmail = process.env.GMAIL_USER || 'me';
const ourDomain = ourEmail.includes('@') ? ourEmail.split('@')[1] : null;
const internalAddrs = [process.env.HIGHLEVEL_EMAIL_FROM]
  .map((v) => (v && v.includes('<') ? v.match(/<([^>]+)>/)?.[1] : v))
  .filter((v): v is string => !!v && v.includes('@'));
const identity = { ourEmail, ourDomain, internalAddrs };
```

and change the `mapGmailThread(raw, ourEmail)` call (line 191) to `mapGmailThread(raw, identity)`.

- [ ] **Step 5: Fix the existing gmail tests** that pass a string as the 2nd arg — wrap them as `{ ourEmail: '<addr>' }`. Run `npx vitest run src/lib/dashboard/inbox/gmail.test.ts`; expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/inbox/gmail.ts src/lib/dashboard/inbox/sync.ts src/lib/dashboard/inbox/gmail.test.ts
git commit -m "fix(#58): treat our whole domain as from-us (escalation self-ingest)"
```

---

## Task 4: Wire `leadKind` + `quoteValue` into the adapters

**Files:**
- Modify: `src/lib/dashboard/inbox/gmail.ts` (fetch `List-Unsubscribe`; set `leadKind`)
- Modify: `src/lib/dashboard/inbox/ghl.ts` (set `leadKind`)
- Modify: `src/lib/dashboard/inbox/quotetool.ts` (set `leadKind: 'lead'`, `quoteValue`)
- Test: `quotetool.test.ts`, `gmail.test.ts`, `ghl.test.ts` (extend)

> `NormalizedTouch.leadKind` / `.quoteValue` are added in Task 5 (types). If executing strictly in order, do Task 5's `types.ts` edit first, or temporarily cast; the recommended order is **5 before 4**. (Listed here grouped by concern; subagent execution should follow the dependency note.)

- [ ] **Step 1: quotetool — failing test** (append to `quotetool.test.ts`)

```ts
it('stamps leadKind lead and the quote dollar value', () => {
  const touch = normalizeQuoteTouch({ id: 'q1', total: 2218.5, customer_email: 'a@b.com' } as any);
  expect(touch.leadKind).toBe('lead');
  expect(touch.quoteValue).toBe(2218.5);
});
```

- [ ] **Step 2: quotetool — implement**

In `quotetool.ts` `normalizeQuoteTouch`, add to the returned object (after `raw: q,`):

```ts
    raw: q,
    leadKind: 'lead',
    quoteValue: q.total ?? null,
```

- [ ] **Step 3: gmail — fetch the List-Unsubscribe header + classify**

In `gmail.ts` `getThread`, add the header to the metadata request — change the loop `for (const h of ['From', 'Subject'])` to `for (const h of ['From', 'Subject', 'List-Unsubscribe'])`.

In `mapGmailThread`, after building `messages`, compute:

```ts
  const hasListUnsubscribe = rawMessages.some((m) => !!getHeader(m, 'List-Unsubscribe'));
```

and add `hasListUnsubscribe` to the returned `GmailThreadLite` (add the field to the `GmailThreadLite` type too). Then in `normalizeGmailThread`, set `leadKind`:

```ts
    leadKind: classifyMessage({
      fromAddress: thread.from?.email ?? null,
      subject: thread.subject ?? null,
      preview: latest?.snippet ?? null,
      hasListUnsubscribe: thread.hasListUnsubscribe,
    }),
```

(import `classifyMessage` from `./classify` at the top).

- [ ] **Step 4: ghl — classify from preview/subject**

In `ghl.ts`, where the inbound touch is built, import `classifyMessage` and set `leadKind: classifyMessage({ fromAddress: null, subject: <subject>, preview: <preview> })` using the same `subject`/`preview` already computed for the touch. (GHL has no List-Unsubscribe; phrase/opt-out detection only — per spec.)

- [ ] **Step 5: Run the adapter tests**

Run: `npx vitest run src/lib/dashboard/inbox/quotetool.test.ts src/lib/dashboard/inbox/gmail.test.ts src/lib/dashboard/inbox/ghl.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/inbox/quotetool.ts src/lib/dashboard/inbox/gmail.ts src/lib/dashboard/inbox/ghl.ts src/lib/dashboard/inbox/*.test.ts
git commit -m "feat(#58): adapters stamp leadKind + quoteValue on each touch"
```

---

## Task 5: Thread the new fields through types + store (+ oldest-first sort + returning proxy)

**Files:**
- Modify: `src/lib/dashboard/inbox/types.ts` (`NormalizedTouch` 52-63; `OpenInboxItem` 67-81)
- Modify: `src/lib/dashboard/inbox/store.ts` (`ItemRow` 45-58; `planIngest` 115-128; `listOpenItems` 308-344)
- Test: `src/lib/dashboard/inbox/store.test.ts` (extend)

- [ ] **Step 1: Extend the types**

In `types.ts`, `NormalizedTouch` — add after `raw?: unknown;`:

```ts
  raw?: unknown;
  leadKind?: 'lead' | 'automated' | null;
  quoteValue?: number | null;
```

`OpenInboxItem` — add after `escalationLevel: number;`:

```ts
  escalationLevel: number;
  leadKind: 'lead' | 'automated';
  quoteValue: number | null;
  isReturning: boolean;
```

- [ ] **Step 2: Extend `ItemRow` + `planIngest` write**

In `store.ts` `ItemRow` (45-58) add:

```ts
  raw: unknown;
  lead_kind: string | null;
  quote_value: number | null;
```

In `planIngest`'s item object (115-128), after `raw: touch.raw ?? null,`:

```ts
    raw: touch.raw ?? null,
    lead_kind: touch.leadKind ?? 'lead',
    quote_value: touch.quoteValue ?? null,
```

(Default `'lead'` so the column is never null after first write; `ingestTouch` already spreads `...plan.item`, so no writer change is needed. Since the classifier is deterministic per touch, re-ingest overwrites with the same value — the null-overwrite gotcha does not apply here.)

- [ ] **Step 3: Failing test for the open-items query** (append to `store.test.ts`, following the file's existing Supabase-mock pattern)

```ts
it('listOpenItems selects the new columns, sorts oldest-first, and maps leadKind/quoteValue/isReturning', async () => {
  // (mirror the existing listOpenItems test's mock; assert .order called with ascending:true,
  //  the select string includes lead_kind and quote_value, and a row with lead_kind:'automated'
  //  + quote_value:2218.5 maps to { leadKind:'automated', quoteValue:2218.5 }, isReturning derived.)
});
```

- [ ] **Step 4: Update `listOpenItems`**

In `store.ts` (311-319): add `lead_kind, quote_value` to the select string; change `.order('last_message_at', { ascending: false })` to `.order('last_message_at', { ascending: true })`.

After fetching `data`, compute the returning proxy with one extra query:

```ts
  const contactIds = [...new Set((data ?? []).map((r: any) => r.contact_id).filter(Boolean))];
  const returning = new Set<string>();
  if (contactIds.length) {
    const { data: counts } = await sb
      .from('inbox_items')
      .select('contact_id')
      .in('contact_id', contactIds);
    const tally = new Map<string, number>();
    for (const row of counts ?? []) {
      const cid = (row as { contact_id: string }).contact_id;
      tally.set(cid, (tally.get(cid) ?? 0) + 1);
    }
    for (const [cid, n] of tally) if (n > 1) returning.add(cid);
  }
```

In the row→`OpenInboxItem` mapper (321-342), add:

```ts
    leadKind: (row.lead_kind === 'automated' ? 'automated' : 'lead'),
    quoteValue: row.quote_value ?? null,
    isReturning: row.contact_id ? returning.has(row.contact_id) : false,
```

- [ ] **Step 5: Run store tests** — `npx vitest run src/lib/dashboard/inbox/store.test.ts`; expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/inbox/types.ts src/lib/dashboard/inbox/store.ts src/lib/dashboard/inbox/store.test.ts
git commit -m "feat(#58): open list carries leadKind/quoteValue/isReturning, oldest-first"
```

---

## Task 6: Pure `buildInboxSummary` (the at-a-glance numbers)

**Files:**
- Create: `src/lib/dashboard/inbox/summary.ts`
- Test: `src/lib/dashboard/inbox/summary.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildInboxSummary } from './summary';
import type { OpenInboxItem } from './types';

const base: OpenInboxItem = {
  id: 'x', source: 'ghl', channel: null, direction: null, lastMessageAt: null, preview: null,
  subject: null, escalationLevel: 0, leadKind: 'lead', quoteValue: null, isReturning: false,
  contactId: null, assignedTo: null, contact: null,
};
const at = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

describe('buildInboxSummary', () => {
  it('counts leads/filtered, oldest wait, overdue, quote $ and per-channel', () => {
    const now = 1_000_000_000_000;
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', source: 'quotetool', leadKind: 'lead', quoteValue: 2218.5, lastMessageAt: at(5 * 3_600_000, now) },
      { ...base, id: 'b', source: 'ghl', leadKind: 'lead', lastMessageAt: at(2 * 3_600_000, now) },
      { ...base, id: 'c', source: 'gmail', leadKind: 'automated', lastMessageAt: at(9 * 3_600_000, now) },
    ];
    const s = buildInboxSummary(items, now);
    expect(s.openLeads).toBe(2);
    expect(s.filtered).toBe(1);
    expect(s.overdue).toBe(1); // only 'a' (5h) is a lead past 4h; 'c' is automated → excluded
    expect(s.oldestWaitingMs).toBe(5 * 3_600_000); // oldest LEAD, not the automated 9h
    expect(s.quotesWaitingUsd).toBe(2218.5);
    expect(s.byChannel).toEqual({ ghl: 1, gmail: 0, quotetool: 1, homeworks: 0 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run src/lib/dashboard/inbox/summary.test.ts` → FAIL (no file).

- [ ] **Step 3: Implement**

```ts
// Pure at-a-glance numbers for the /inbox summary strip (#58). Derived entirely
// from the already-fetched open-item list, so the strip tracks the client poll
// with no extra server round-trip. "Filtered" = automated noise; everything else
// here is computed over LEADS only (the work that actually needs a reply).

import type { OpenInboxItem, InboxSource } from './types';
import { INBOX_SOURCES } from './types';
import { ESCALATION } from './escalation';

export type InboxSummary = {
  openLeads: number;
  filtered: number;
  overdue: number;
  oldestWaitingMs: number;
  quotesWaitingUsd: number;
  byChannel: Record<InboxSource, number>;
};

export function buildInboxSummary(items: OpenInboxItem[], nowMs: number): InboxSummary {
  const leads = items.filter((i) => i.leadKind !== 'automated');
  const byChannel = Object.fromEntries(INBOX_SOURCES.map((s) => [s, 0])) as Record<InboxSource, number>;
  let oldestWaitingMs = 0;
  let overdue = 0;
  let quotesWaitingUsd = 0;
  for (const i of leads) {
    byChannel[i.source] += 1;
    if (i.quoteValue) quotesWaitingUsd += i.quoteValue;
    if (i.lastMessageAt) {
      const wait = nowMs - new Date(i.lastMessageAt).getTime();
      if (wait > oldestWaitingMs) oldestWaitingMs = wait;
      if (wait >= ESCALATION.redAfterMs) overdue += 1;
    }
  }
  return {
    openLeads: leads.length,
    filtered: items.length - leads.length,
    overdue,
    oldestWaitingMs,
    quotesWaitingUsd,
    byChannel,
  };
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/inbox/summary.ts src/lib/dashboard/inbox/summary.test.ts
git commit -m "feat(#58): pure buildInboxSummary for the at-a-glance strip"
```

---

## Task 7: At-a-glance strip component

**Files:**
- Create: `src/components/dashboard/inbox/InboxSummaryStrip.tsx`

- [ ] **Step 1: Implement the presentational strip** (no test — pure presentational; logic is in Task 6)

```tsx
import type { InboxSummary } from '@/lib/dashboard/inbox/summary';

function fmtWait(ms: number): string {
  if (ms <= 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Tile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-md p-3" style={{ background: 'var(--op-bg-raised)' }}>
      <div className="text-xs" style={{ color: 'var(--op-text-2)' }}>{label}</div>
      <div className="text-2xl font-semibold" style={{ color: danger ? '#dc2626' : 'var(--op-text)' }}>{value}</div>
    </div>
  );
}

export function InboxSummaryStrip({ summary }: { summary: InboxSummary }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <Tile label="Oldest waiting" value={fmtWait(summary.oldestWaitingMs)} danger={summary.overdue > 0} />
      <Tile label="Overdue over 4h" value={String(summary.overdue)} danger={summary.overdue > 0} />
      <Tile label="In quotes waiting" value={`$${Math.round(summary.quotesWaitingUsd).toLocaleString()}`} />
      <Tile label="Open leads" value={`${summary.openLeads}${summary.filtered ? ` · ${summary.filtered} filtered` : ''}`} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/dashboard/inbox/InboxSummaryStrip.tsx
git commit -m "feat(#58): at-a-glance summary strip component"
```

---

## Task 8: Filter tiles, "show filtered" toggle, strip wiring, enriched cards

**Files:**
- Modify: `src/components/dashboard/inbox/InboxList.tsx`

- [ ] **Step 1: Add filter + show-filtered state** — after the existing `const [now, setNow] = useState(...)` block, add:

```tsx
  const [channel, setChannel] = useState<'all' | 'ghl' | 'gmail' | 'quotetool' | 'homeworks'>('all');
  const [showFiltered, setShowFiltered] = useState(false);
```

- [ ] **Step 2: Compute the summary + the visible list** — before the `return (`:

```tsx
  const summary = buildInboxSummary(items, now);
  const visible = items
    .filter((i) => showFiltered || i.leadKind !== 'automated')
    .filter((i) => channel === 'all' || i.source === channel);
```

(import `buildInboxSummary` from `@/lib/dashboard/inbox/summary` and `InboxSummaryStrip` from `./InboxSummaryStrip`; change the existing `.map` source from `items` to `visible`.)

- [ ] **Step 3: Render the strip + tiles** — at the top of the returned JSX (before the `<ul>`):

```tsx
      <InboxSummaryStrip summary={summary} />
      <div className="flex items-center flex-wrap gap-2 mb-4">
        {(['all', 'gmail', 'ghl', 'quotetool'] as const).map((c) => (
          <button key={c} type="button" onClick={() => setChannel(c)}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{ border: c === channel ? '2px solid var(--brand-evergreen)' : '1px solid var(--op-border)', color: 'var(--op-text)' }}>
            {c === 'all' ? `All ${summary.openLeads}` : `${SOURCE_LABEL[c] ?? c} ${summary.byChannel[c] ?? 0}`}
          </button>
        ))}
        <span className="flex-1" />
        {summary.filtered > 0 && (
          <button type="button" onClick={() => setShowFiltered((v) => !v)} className="text-sm underline" style={{ color: 'var(--op-text-2)' }}>
            {showFiltered ? 'Hide filtered' : `Show ${summary.filtered} filtered`}
          </button>
        )}
        <Link href="/inbox/settings" aria-label="Inbox settings" style={{ color: 'var(--op-text-2)' }}>⚙</Link>
      </div>
```

(import `Link` from `next/link`.)

- [ ] **Step 4: Enrich the card** — in the name/badge row (`InboxList.tsx:145-147`, the `SOURCE_LABEL` span), append after it:

```tsx
                  {item.quoteValue ? (
                    <span className="text-xs font-medium" style={{ color: 'var(--op-text)' }}>${Math.round(item.quoteValue).toLocaleString()}</span>
                  ) : null}
                  <span className="text-xs uppercase tracking-wide" style={{ color: item.isReturning ? 'var(--op-text-2)' : 'var(--brand-evergreen-3)' }}>
                    {item.isReturning ? 'Returning' : 'New lead'}
                  </span>
                  {item.leadKind === 'automated' && (
                    <span className="text-xs" style={{ color: 'var(--op-text-2)' }}>· filtered</span>
                  )}
```

- [ ] **Step 5: Gates** — `npx tsc --noEmit` (expect 0) and a render sanity check; the file has no unit test (Konva-free but client-rendered — verified on preview). Run the full suite to ensure nothing else broke: `npx vitest run`.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/inbox/InboxList.tsx
git commit -m "feat(#58): inbox strip, channel filters, show-filtered, enriched cards"
```

---

## Task 9: Settings stub page (the gear target)

**Files:**
- Create: `src/app/inbox/settings/page.tsx`

- [ ] **Step 1: Implement a minimal stub** (matches the `/settings/customer-portal` "coming soon" precedent; gives the gear a real destination without scope creep)

```tsx
import { OperatorShell } from '@/components/dashboard/OperatorShell';

export const dynamic = 'force-dynamic';

export default function InboxSettingsPage() {
  return (
    <OperatorShell active="inbox">
      <div className="max-w-2xl mx-auto w-full">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>Inbox settings</h1>
        <p className="text-sm mt-2" style={{ color: 'var(--op-text-2)' }}>
          Escalation timing and noise-filter controls will live here. Escalation is currently amber after 1h,
          red after 4h, with an end-of-day digest (America/New_York).
        </p>
      </div>
    </OperatorShell>
  );
}
```

(Confirm the `OperatorShell` import path matches the one `src/app/inbox/page.tsx` uses.)

- [ ] **Step 2: Commit**

```bash
git add src/app/inbox/settings/page.tsx
git commit -m "feat(#58): inbox settings stub (gear target)"
```

---

## Final verification

- [ ] **All gates green from the worktree:** `npx tsc --noEmit` (0 errors) · `npm run lint` (0 errors) · `npx vitest run` (all pass, including the new classify/summary/gmail/store tests).
- [ ] **Manual preview check** (Vercel branch preview, since Konva/poll aren't headless-testable): the strip shows oldest-waiting/overdue/$ /open; channel tiles filter; the escalation emails + Jobber/automated mail are hidden by default and appear under "Show N filtered"; cards show $ on quotes + New lead/Returning; the list is oldest-first.
- [ ] **Migration applied to prod** (human-gated, Chrome + Supabase SQL editor) before/with merge — the columns are additive + nullable so code tolerates pre-apply, but they must exist before the new `quote_value`/`lead_kind` reads return data.

## Spec coverage self-check
- At-a-glance strip → Tasks 6, 7, 8. Channel tiles + Settings → Tasks 8, 9. Oldest-first sort → Task 5. Enriched cards ($, new/returning) → Tasks 5, 8. Noise: layer 1 (domain=us) → Task 3; layer 2 (automated) → Tasks 2, 4, 8; layer 3 → deferred to v2 (flagged). $ source → Task 4 (`q.total`). New/returning → Task 5 (history proxy). v2 (AI draft, reply-inline, layer-3 learning) → not in this plan, by design.
