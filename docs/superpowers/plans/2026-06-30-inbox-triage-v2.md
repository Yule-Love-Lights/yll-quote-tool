# Inbox triage v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator reply to a customer from `/inbox` — an AI-drafted, human-reviewed message sent through the existing GHL path — and finish the noise story (layer-3: "Not a lead" learns the sender).

**Architecture:** Two thin server routes (`/draft`, `/reply`) over two pure units (`buildDraftPrompt`, `resolveReplyTarget`), reusing the existing Claude client (`src/lib/claude.ts`, model `claude-sonnet-4-6`), GHL send (`highlevel.ts`), and `markItemHandledLocal` + Full-Handled write-back. A dashboard-owned suppression store keeps layer-3 entirely in our area (no edit to Jason's `appSettings.ts`). The reply composer lives in the existing `InboxList` card.

**Tech Stack:** Next.js route handlers, TypeScript, `@anthropic-ai/sdk` (already a dep), Supabase service-role, GHL Conversations API, Vitest. Gates from the worktree: `npx tsc --noEmit`, `npm run lint` (NO `any` — it's an error), `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-30-inbox-triage-v2-design.md` · **Builds on:** v1 (`naldo/inbox-triage-v1`).

**No new deps, no migration, no new OAuth scope.** Reuses `ANTHROPIC_API_KEY`, `HIGHLEVEL_*`, `app_settings`.

---

## File map

**Create:**
- `src/lib/dashboard/inbox/draft.ts` + `.test.ts` — pure `buildDraftPrompt`
- `src/lib/dashboard/inbox/reply.ts` + `.test.ts` — pure `resolveReplyTarget`
- `src/lib/dashboard/inbox/suppression.ts` + `.test.ts` — suppression store (dashboard-owned `app_settings` key) + pure normalize
- `src/app/api/dashboard/draft/route.ts` — POST: build context → Claude → `{ draft }`
- `src/app/api/dashboard/reply/route.ts` — POST: route → GHL send → mark Handled

**Modify:**
- `src/lib/dashboard/inbox/store.ts` — add `getItemForReply` (resolve send target) + `dismissItem` captures sender
- `src/lib/dashboard/inbox/gmail.ts` + `ghl.ts` — adapters accept a `suppressed` set, classify suppressed senders as `automated`
- `src/lib/dashboard/inbox/sync.ts` — load the suppression set once per reconcile, pass to adapters
- `src/app/api/dashboard/dismiss/route.ts` — unchanged logic; `dismissItem` now appends the sender
- `src/components/dashboard/inbox/InboxList.tsx` — reply composer (AI draft + textarea + Send + quote channel toggle + Gmail hint)

---

## Task 1: Pure `buildDraftPrompt`

**Files:** Create `src/lib/dashboard/inbox/draft.ts`, `src/lib/dashboard/inbox/draft.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildDraftPrompt, type DraftContext } from './draft';

const base: DraftContext = {
  customerName: 'Jane', source: 'ghl', channel: 'sms',
  recentMessages: [{ fromCustomer: true, text: 'How much for my roofline?' }],
  quoteTotal: null,
};

describe('buildDraftPrompt', () => {
  it('encodes the no-hard-commitments guardrail and the YLL sign-off in the system prompt', () => {
    const { system } = buildDraftPrompt(base);
    expect(system.toLowerCase()).toContain('do not');
    expect(system.toLowerCase()).toMatch(/price|date|schedul/);
    expect(system).toContain('Yule Love Lights team');
  });
  it('puts the customer name and the recent message into the user prompt', () => {
    const { user } = buildDraftPrompt(base);
    expect(user).toContain('Jane');
    expect(user).toContain('How much for my roofline?');
  });
  it('labels who said what', () => {
    const { user } = buildDraftPrompt({ ...base, recentMessages: [
      { fromCustomer: true, text: 'hi' }, { fromCustomer: false, text: 'hello' },
    ] });
    expect(user).toMatch(/customer/i);
    expect(user).toMatch(/us|you|team/i);
  });
  it('mentions the customer has a quote when quoteTotal is set, without stating the number as a promise', () => {
    const { user } = buildDraftPrompt({ ...base, source: 'quotetool', quoteTotal: 2218.5 });
    expect(user.toLowerCase()).toContain('quote');
  });
});
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run src/lib/dashboard/inbox/draft.test.ts`).

- [ ] **Step 3: Implement `draft.ts`**

```ts
// Pure prompt builder for an AI-drafted inbox reply (#58 v2). No I/O — the route
// gathers context, this assembles the prompt, the route calls Claude. Guardrails
// (no specific prices/dates/scheduling) live here as defense-in-depth even though
// a human reviews + sends every draft.

import type { InboxSource } from './types';

export type DraftContext = {
  customerName: string | null;
  source: InboxSource;
  channel: string | null;
  /** Recent messages on the thread, oldest→newest. Empty for a fresh quote lead. */
  recentMessages: { fromCustomer: boolean; text: string }[];
  /** The quote $ total, for quote-lead follow-ups (context only — never quote it as a promise). */
  quoteTotal: number | null;
};

const SYSTEM = [
  'You draft short reply messages for Yule Love Lights, a Christmas/holiday lighting company,',
  'to send to a customer. Write warm, friendly, concise, professional replies.',
  'Hard rules — DO NOT state specific prices, dollar amounts, install or takedown dates, or',
  'scheduling promises. If the customer asks about price/timing, acknowledge and say a member of',
  'our team will confirm the exact details. Never invent facts. Keep it to 1–3 short sentences.',
  'Sign off as "the Yule Love Lights team" (no placeholders, no signature block).',
  'Output ONLY the reply text — no preamble, no quotes around it.',
].join(' ');

export function buildDraftPrompt(ctx: DraftContext): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`Customer name: ${ctx.customerName ?? 'there'}.`);
  lines.push(`Channel: ${ctx.channel ?? 'message'}.`);
  if (ctx.source === 'quotetool') {
    lines.push(
      ctx.quoteTotal != null
        ? 'Context: this customer has an open quote with us and has not replied yet. Write a brief, friendly follow-up nudging them to review it. Do not state the quote amount.'
        : 'Context: this is a new lead with an open quote. Write a brief, friendly follow-up.',
    );
  }
  if (ctx.recentMessages.length) {
    lines.push('', 'Recent conversation (oldest first):');
    for (const m of ctx.recentMessages) lines.push(`${m.fromCustomer ? 'Customer' : 'Us (Yule Love Lights team)'}: ${m.text}`);
    lines.push('', 'Draft our reply to the latest customer message.');
  }
  return { system: SYSTEM, user: lines.join('\n') };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/draft.ts src/lib/dashboard/inbox/draft.test.ts && git commit -m "feat(#58): pure buildDraftPrompt for AI reply drafts"`

---

## Task 2: Pure `resolveReplyTarget`

**Files:** Create `src/lib/dashboard/inbox/reply.ts`, `src/lib/dashboard/inbox/reply.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveReplyTarget } from './reply';

describe('resolveReplyTarget', () => {
  it('routes a GHL sms item to sendSms with the contact id', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'sms', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c1' });
  });
  it('routes a GHL email item to sendEmail', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'email', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'email', contactId: 'c1' });
  });
  it('defaults a GHL call/unknown channel to sms', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'call', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c1' });
  });
  it('routes a quote lead to email by default, honoring an explicit channel choice', () => {
    expect(resolveReplyTarget({ source: 'quotetool', channel: 'app', ghlContactId: 'c9' }))
      .toEqual({ kind: 'send', via: 'email', contactId: 'c9' });
    expect(resolveReplyTarget({ source: 'quotetool', channel: 'app', ghlContactId: 'c9' }, 'sms'))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c9' });
  });
  it('refuses gmail (no inline send in v2)', () => {
    expect(resolveReplyTarget({ source: 'gmail', channel: 'email', ghlContactId: null }).kind).toBe('unsupported');
  });
  it('flags a missing GHL contact id', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'sms', ghlContactId: null }).kind).toBe('no_contact');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `reply.ts`**

```ts
// Pure reply-routing decision (#58 v2). Given an item's source/channel/GHL contact,
// decide how to send. The route executes the decision (sendSms/sendEmail). No I/O.

import type { InboxSource } from './types';

export type ReplyTarget =
  | { kind: 'send'; via: 'sms' | 'email'; contactId: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'no_contact'; reason: string };

export function resolveReplyTarget(
  item: { source: InboxSource; channel: string | null; ghlContactId: string | null },
  chosenChannel?: 'sms' | 'email',
): ReplyTarget {
  if (item.source === 'gmail') {
    return { kind: 'unsupported', reason: 'Reply to Gmail threads in Gmail — inline send is not available for email yet.' };
  }
  if (item.source === 'homeworks') {
    return { kind: 'unsupported', reason: 'Homeworks items are read-only.' };
  }
  if (!item.ghlContactId) {
    return { kind: 'no_contact', reason: 'No GoHighLevel contact linked — open this customer in GHL to reply.' };
  }
  // Quote leads default to email; GHL items follow their channel; calls/unknown → sms.
  let via: 'sms' | 'email';
  if (chosenChannel) via = chosenChannel;
  else if (item.source === 'quotetool') via = 'email';
  else via = item.channel === 'email' ? 'email' : 'sms';
  return { kind: 'send', via, contactId: item.ghlContactId };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/reply.ts src/lib/dashboard/inbox/reply.test.ts && git commit -m "feat(#58): pure resolveReplyTarget routing"`

---

## Task 3: Suppression store (dashboard-owned `app_settings` key)

**Files:** Create `src/lib/dashboard/inbox/suppression.ts`, `src/lib/dashboard/inbox/suppression.test.ts`

> Stays in-area: reads/writes the `dashboard.suppressedSenders` row directly via the service client (does NOT touch Jason's `appSettings.ts`, which only reads its own 4 keys).

- [ ] **Step 1: Failing test** (pure normalize only — the I/O fns are thin glue)

```ts
import { describe, it, expect } from 'vitest';
import { normalizeSuppressionValues } from './suppression';

describe('normalizeSuppressionValues', () => {
  it('lowercases emails and E.164-normalizes phones, dropping blanks/dupes', () => {
    const out = normalizeSuppressionValues(['  Sales@Vendor.COM ', '(631) 481-9575', 'sales@vendor.com', '', null]);
    expect(out).toContain('sales@vendor.com');
    expect(out).toContain('+16314819575');
    expect(out.filter((v) => v === 'sales@vendor.com')).toHaveLength(1);
    expect(out).not.toContain('');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `suppression.ts`**

```ts
// Layer-3 sender suppression (#58 v2). A dashboard-owned list of senders whose
// future messages auto-classify as 'automated'. Stored as the app_settings row
// keyed 'dashboard.suppressedSenders' (a string[]), read/written directly via the
// service-role client — kept out of Jason's appSettings.ts so this stays in-area.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { normalizeEmail, normalizePhone } from './normalize';

const KEY = 'dashboard.suppressedSenders';

/** Normalize raw sender identifiers (emails → lowercased, phones → E.164), drop blanks + dupes. */
export function normalizeSuppressionValues(values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const s = v.trim();
    if (!s) continue;
    const email = s.includes('@') ? normalizeEmail(s) : null;
    const phone = !email ? normalizePhone(s) : null;
    const norm = email ?? phone ?? s.toLowerCase();
    if (norm) out.add(norm);
  }
  return [...out];
}

/** The current suppression set (normalized). Fail-safe: empty set on any error. */
export async function getSuppressedSenders(): Promise<Set<string>> {
  const sb = getSupabaseServiceClient();
  if (!sb) return new Set();
  const { data, error } = await sb.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error || !data) return new Set();
  const list = Array.isArray((data as { value?: unknown }).value) ? ((data as { value: unknown[] }).value as unknown[]) : [];
  return new Set(normalizeSuppressionValues(list.map((x) => (typeof x === 'string' ? x : null))));
}

/** Add senders to the suppression list (idempotent, normalized). Best-effort. */
export async function addSuppressedSenders(values: (string | null | undefined)[]): Promise<void> {
  const additions = normalizeSuppressionValues(values);
  if (!additions.length) return;
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const current = await getSuppressedSenders();
  for (const a of additions) current.add(a);
  await sb.from('app_settings').upsert({ key: KEY, value: [...current] }, { onConflict: 'key' });
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/suppression.ts src/lib/dashboard/inbox/suppression.test.ts && git commit -m "feat(#58): layer-3 sender-suppression store"`

---

## Task 4: Adapters honor the suppression set

**Files:** Modify `src/lib/dashboard/inbox/gmail.ts`, `ghl.ts`, `sync.ts`; tests in `gmail.test.ts`, `ghl.test.ts`

- [ ] **Step 1: Failing tests** (append)

`gmail.test.ts`:
```ts
it('classifies a suppressed sender as automated', () => {
  const raw = { id: 't9', messages: [{ id: 'm', labelIds: ['INBOX'], internalDate: '1', payload: { headers: [
    { name: 'From', value: 'Repeat Junk <spam@vendor.com>' }, { name: 'Subject', value: 'Hi' } ] } }] };
  const thread = mapGmailThread(raw, { ourEmail: 'info@yulelovelights.com' });
  const touch = normalizeGmailThread(thread, new Set(['spam@vendor.com']));
  expect(touch.leadKind).toBe('automated');
});
```
`ghl.test.ts`: a conversation whose contact email/phone is in the suppressed set → `normalizeGhlConversation(c, new Set(['+16314819575'])).leadKind === 'automated'` (use whatever field the adapter reads for the sender — phone/email on the conversation row).

- [ ] **Step 2: Run → FAIL** (the adapters don't take a second arg yet).

- [ ] **Step 3: Implement**

In `gmail.ts`, change `normalizeGmailThread(thread)` → `normalizeGmailThread(thread, suppressed?: Set<string>)`. Before returning, compute the sender and short-circuit:
```ts
  const senderEmail = thread.from?.email ?? null;
  const leadKind = suppressed && senderEmail && suppressed.has(senderEmail.toLowerCase())
    ? 'automated'
    : classifyMessage({ fromAddress: senderEmail, subject: thread.subject ?? null, preview: latest?.snippet ?? null, hasListUnsubscribe: thread.hasListUnsubscribe });
```
and use `leadKind` in the returned object.

In `ghl.ts`, change `normalizeGhlConversation(c)` → `normalizeGhlConversation(c, suppressed?: Set<string>)`. The GHL sender identifiers are the conversation's email/phone (already normalized into `identity` — reuse the same `normalizeEmail(c.email)` / `normalizePhone(c.phone)` the adapter already computes). Short-circuit to `'automated'` when either is in `suppressed`, else the existing `classifyMessage({ fromAddress: null, subject: null, preview })`.

In `sync.ts`, in each reconcile fn (`runGhlReconcile`, `runGmailPoll`) load the set once before the loop: `const suppressed = await getSuppressedSenders();` (import from `./suppression`), and pass it: `normalizeGhlConversation(c, suppressed)` / `normalizeGmailThread(mapGmailThread(raw, identity), suppressed)`. (quotetool is first-party — no change.)

- [ ] **Step 4: Run gmail + ghl tests → PASS; `npx tsc --noEmit` → 0.**
- [ ] **Step 5: Commit** — `git add src/lib/dashboard/inbox/gmail.ts src/lib/dashboard/inbox/ghl.ts src/lib/dashboard/inbox/sync.ts src/lib/dashboard/inbox/gmail.test.ts src/lib/dashboard/inbox/ghl.test.ts && git commit -m "feat(#58): adapters honor the sender-suppression set"`

---

## Task 5: "Not a lead" learns the sender

**Files:** Modify `src/lib/dashboard/inbox/store.ts` (`dismissItem`)

- [ ] **Step 1: Implement** — change `dismissItem` to capture the sender (via the `markItemHandledLocal` join idiom) and append it to suppression. Replace the blind update with:

```ts
export async function dismissItem(itemId: string, operatorId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .update({ status: 'dismissed', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId)
    .select('dashboard_contacts ( primary_email, primary_phone )')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'dismissed', inbox_item_id: itemId });
  const c = (data as { dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null } } | null)?.dashboard_contacts;
  if (c) await addSuppressedSenders([c.primary_email ?? null, c.primary_phone ?? null]);
  return { ok: true };
}
```
Add `import { addSuppressedSenders } from './suppression';` at the top of `store.ts`. (The dismiss route is unchanged — it still calls `dismissItem(itemId, …)`.) This is service-role glue (untested per the store header); covered by tsc + review.

- [ ] **Step 2: `npx tsc --noEmit` → 0; `npm run lint` → 0 errors; `npx vitest run src/lib/dashboard/inbox/store.test.ts` (existing dismiss tests still pass).**
- [ ] **Step 3: Commit** — `git add src/lib/dashboard/inbox/store.ts && git commit -m "feat(#58): Not-a-lead appends the sender to suppression"`

---

## Task 6: `getItemForReply` store helper

**Files:** Modify `src/lib/dashboard/inbox/store.ts`

- [ ] **Step 1: Implement** — add a reader that resolves an item to its send target + draft context source:

```ts
export type ReplyItem = {
  id: string;
  source: InboxSource;
  channel: string | null;
  externalId: string;
  ghlContactId: string | null;
  customerName: string | null;
  quoteTotal: number | null;
};

export async function getItemForReply(itemId: string): Promise<ReplyItem | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data } = await sb
    .from('inbox_items')
    .select('id, source, channel, external_id, quote_value, raw, dashboard_contacts ( ghl_contact_id, display_name )')
    .eq('id', itemId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  const c = (row.dashboard_contacts as { ghl_contact_id?: string | null; display_name?: string | null } | null) ?? null;
  const raw = (row.raw as { highlevel_contact_id?: string | null; customer_name?: string | null } | null) ?? null;
  return {
    id: String(row.id),
    source: row.source as InboxSource,
    channel: (row.channel as string | null) ?? null,
    externalId: String(row.external_id),
    ghlContactId: (c?.ghl_contact_id as string | null) ?? (raw?.highlevel_contact_id ?? null),
    customerName: (c?.display_name as string | null) ?? (raw?.customer_name ?? null),
    quoteTotal: (row.quote_value as number | null) ?? null,
  };
}
```
(GHL contact id prefers the joined contact, falling back to the quote's `raw.highlevel_contact_id`.) Service-role glue.

- [ ] **Step 2: `npx tsc --noEmit` → 0; `npm run lint` → 0 errors.**
- [ ] **Step 3: Commit** — `git add src/lib/dashboard/inbox/store.ts && git commit -m "feat(#58): getItemForReply send-target resolver"`

---

## Task 7: Draft route — `POST /api/dashboard/draft`

**Files:** Create `src/app/api/dashboard/draft/route.ts`

- [ ] **Step 1: Implement** (follow the existing dashboard-route idiom: `getOperator()` gate, `rateLimitResponse`, `isUuid`, `runtime = 'nodejs'`)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { getClaudeClient } from '@/lib/claude';
import { getItemForReply } from '@/lib/dashboard/inbox/store';
import { getConversationMessages } from '@/lib/integrations/highlevel';
import { buildDraftPrompt, type DraftContext } from '@/lib/dashboard/inbox/draft';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!(await getOperator())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rl = rateLimitResponse(req, { bucket: 'dashboard-draft', limit: 30, windowMs: 60_000 });
  if (rl) return rl;
  const body = await req.json().catch(() => ({}));
  const { itemId } = body as { itemId?: unknown };
  if (!isUuid(itemId)) return NextResponse.json({ error: 'Valid itemId (uuid) required' }, { status: 400 });

  const client = getClaudeClient();
  if (!client) return NextResponse.json({ error: 'AI drafting not configured' }, { status: 503 });
  const item = await getItemForReply(itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  let recentMessages: DraftContext['recentMessages'] = [];
  if (item.source === 'ghl') {
    try {
      const { messages } = await getConversationMessages(item.externalId);
      recentMessages = messages.slice(-8).map((m) => ({
        fromCustomer: m.direction !== 'outbound',
        text: (m.body ?? m.messageType ?? '').toString().slice(0, 500),
      })).filter((m) => m.text);
    } catch { recentMessages = []; }
  }
  const { system, user } = buildDraftPrompt({
    customerName: item.customerName, source: item.source, channel: item.channel, recentMessages, quoteTotal: item.quoteTotal,
  });
  try {
    const resp = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 400, system, messages: [{ role: 'user', content: user }] });
    const block = resp.content.find((b) => b.type === 'text');
    const draft = block && block.type === 'text' ? block.text.trim() : '';
    if (!draft) return NextResponse.json({ error: 'No draft produced' }, { status: 502 });
    return NextResponse.json({ ok: true, draft });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : 'Draft failed' }, { status: 502 });
  }
}
```
> Confirm at build: the exact `HighLevelMessage` field names for body/direction (read the type in `highlevel.ts`); adjust `m.body`/`m.direction` to the real fields. Add the route to `operatorGate` only if your gate requires explicit listing — `/api/dashboard/*` operator routes are gated by the session, not the public allowlist, so no allowlist entry is needed (it must NOT be public).

- [ ] **Step 2: tsc + lint → clean.** (Route is thin; a happy-path test is optional — if you add one, mock `getClaudeClient`/`getItemForReply`/`getConversationMessages`.)
- [ ] **Step 3: Commit** — `git add src/app/api/dashboard/draft/route.ts && git commit -m "feat(#58): AI draft route"`

---

## Task 8: Reply route — `POST /api/dashboard/reply`

**Files:** Create `src/app/api/dashboard/reply/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { getItemForReply, markItemHandledLocal, recordWriteback } from '@/lib/dashboard/inbox/store';
import { resolveReplyTarget } from '@/lib/dashboard/inbox/reply';
import { sendSms, sendEmail } from '@/lib/integrations/highlevel';
import { runHandledWriteback } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rl = rateLimitResponse(req, { bucket: 'dashboard-reply', limit: 60, windowMs: 60_000 });
  if (rl) return rl;
  const body = await req.json().catch(() => ({}));
  const { itemId, text, channel } = body as { itemId?: unknown; text?: unknown; channel?: unknown };
  if (!isUuid(itemId)) return NextResponse.json({ error: 'Valid itemId (uuid) required' }, { status: 400 });
  if (typeof text !== 'string' || !text.trim()) return NextResponse.json({ error: 'Message text required' }, { status: 400 });
  const chosen = channel === 'sms' || channel === 'email' ? channel : undefined;

  const item = await getItemForReply(itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  const target = resolveReplyTarget(item, chosen);
  if (target.kind !== 'send') return NextResponse.json({ error: target.reason }, { status: 400 });

  try {
    if (target.via === 'sms') {
      await sendSms({ contactId: target.contactId, message: text.trim(), fromNumber: process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined });
    } else {
      await sendEmail({ contactId: target.contactId, subject: 'Re: your Yule Love Lights inquiry', html: text.trim().replace(/\n/g, '<br>'), emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : 'Send failed' }, { status: 502 });
  }
  // Sent → mark handled (+ Full-Handled write-back). Failure here doesn't unsend; report ok with a flag.
  const local = await markItemHandledLocal(itemId, operator.id, new Date());
  if (local.ok && local.target) {
    const sync = await runHandledWriteback(local.target, operator.email ?? operator.id);
    await recordWriteback(itemId, sync);
  }
  return NextResponse.json({ ok: true });
}
```
> Confirm at build: `markItemHandledLocal`'s exact return shape (the v1 findings show it returns `{ ok, target?, error? }` with `target: HandledTarget`) and `recordWriteback`'s signature — match them. The email subject is a sensible default; if the GHL item carries a subject you may thread it through `getItemForReply`.

- [ ] **Step 2: tsc + lint → clean.**
- [ ] **Step 3: Commit** — `git add src/app/api/dashboard/reply/route.ts && git commit -m "feat(#58): reply route — GHL send then mark handled"`

---

## Task 9: Reply composer in the card

**Files:** Modify `src/components/dashboard/inbox/InboxList.tsx`

- [ ] **Step 1: Implement** — add per-item composer state and UI. READ the file first. Add to the component:
  - state: `const [composerFor, setComposerFor] = useState<string | null>(null); const [draftText, setDraftText] = useState(''); const [draftBusy, setDraftBusy] = useState<string | null>(null); const [sendBusy, setSendBusy] = useState<string | null>(null); const [replyChannel, setReplyChannel] = useState<'sms' | 'email'>('email');`
  - A "Reply" button on each non-Gmail card that toggles `composerFor`. Gmail cards show a muted "Reply in Gmail" hint instead.
  - When `composerFor === item.id`, render below the actions: a channel toggle for quote-lead cards (sms/email), an "AI draft" button (POSTs `{ itemId }` to `/api/dashboard/draft`, sets `draftText` from `res.draft`, with `draftBusy`), a `<textarea value={draftText} onChange=…>`, and a "Send" button (POSTs `{ itemId, text: draftText, channel: item.source === 'quotetool' ? replyChannel : undefined }` to `/api/dashboard/reply`; on `ok`, remove the item from the list like `act()` does — reuse the existing optimistic-removal helper).
  - Errors: surface the route's `error` string inline (small red text); on send failure, keep the item + composer open.

  Match the file's existing fetch/optimistic pattern (the `act()` helper for Handled/dismiss). Keep buttons in the existing style (`var(--brand-evergreen)` / `var(--op-*)` tokens).

- [ ] **Step 2: `npx tsc --noEmit` → 0; `npm run lint` → 0; `npx vitest run` (full suite still green — UI has no unit test, verify on preview).**
- [ ] **Step 3: Commit** — `git add src/components/dashboard/inbox/InboxList.tsx && git commit -m "feat(#58): reply composer (AI draft + edit + send) in the card"`

---

## Final verification
- [ ] `npx tsc --noEmit` (0) · `npm run lint` (0 errors) · `npx vitest run` (all pass, incl. new draft/reply/suppression + adapter suppression tests).
- [ ] Preview check: "AI draft" fills a sensible, guardrail-respecting draft; edit + Send delivers via GHL and the item clears (marked Handled); Gmail cards show the "reply in Gmail" hint (no composer); "Not a lead" on a junk sender → that sender's next message ingests hidden.

## Spec coverage self-check
- Reply-inline (GHL + quote, no Gmail send) → Tasks 2, 6, 8, 9. AI draft (Sonnet, on-demand, guardrails) → Tasks 1, 7, 9. Send→Handled → Task 8. Layer-3 (suppression + Not-a-lead learns) → Tasks 3, 4, 5. Quote-lead default email + channel toggle → Tasks 2, 9. Gmail refused → Tasks 2, 8, 9. No new dep/migration/scope → confirmed (reuses claude.ts, highlevel.ts, app_settings).

## Notes / confirm-at-build
- `HighLevelMessage` body/direction field names (Task 7) — read the type in `highlevel.ts`.
- `markItemHandledLocal` / `recordWriteback` exact shapes (Task 8) — match the real signatures.
- `getOperator()`/`rateLimitResponse`/`isUuid` import paths — mirror an existing `src/app/api/dashboard/*/route.ts`.
