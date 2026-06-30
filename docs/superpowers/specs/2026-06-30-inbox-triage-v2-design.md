# Inbox triage v2 — design spec

**Date:** 2026-06-30 · **Area:** Dashboard `/inbox` (#58, Naldo) · **Status:** design, awaiting review
**Builds on:** inbox triage v1 (PR #258 / branch `naldo/inbox-triage-v1`).

## Why

v1 makes the inbox trustworthy and triageable (at-a-glance strip, oldest-first, noise filtered). v2 closes
the loop: **respond to a customer without leaving the dashboard**, with an AI-drafted reply you review and
send. Speed-to-reply is the #1 business goal; today an operator reads the inbox here but switches to GHL to
actually answer. v2 also finishes the noise story (layer-3: "Not a lead" learns the sender).

## Locked decisions (from brainstorming)

- **Send model: human-in-the-loop.** AI drafts → operator reviews/edits → operator clicks Send. Never auto-send.
- **Channels: GHL + quote leads only.** Replies route through the existing GHL send path (`sendSms`/`sendEmail`).
  Gmail inline send is **out of scope** (would need the `gmail.send` scope + re-consent) — Gmail items stay
  read-only in the inbox with a "reply in Gmail" hint.
- **AI draft guardrails: no hard commitments.** Drafts are warm, brief, on-brand, and **never state specific
  prices, install/takedown dates, or scheduling promises** — those route to "a team member will confirm…".
  Sign-off: "the Yule Love Lights team." Model: Claude **Sonnet**. Trigger: **on-demand** ("AI draft" button).
- **Sending marks the item Handled** (runs the existing Full-Handled write-back). Send failure → item stays open.
- **Quote-lead reply default channel = email**, with SMS selectable in the composer.
- **Layer-3 included:** "Not a lead" remembers the sender; future messages from a suppressed sender auto-hide.

## Non-goals (v2)

- Gmail inline send (deferred — needs `gmail.send` re-consent).
- Auto-send / one-click AI send (rejected — human reviews every outgoing message).
- Anything beyond the three capabilities below.

## Components (built for isolation + testing; all reuse existing infra)

No new dependencies, no migration, no new OAuth scope. Reuses: the Anthropic SDK + `ANTHROPIC_API_KEY`
(already used by `photoAnalysis.ts`), GHL `sendSms`/`sendEmail`/`getConversationMessages` (`highlevel.ts`),
the `app_settings` kv table, and the existing `markItemHandledLocal` + Full-Handled write-back.

### 1. Reply-inline — `POST /api/dashboard/reply`
- Input: inbox item id + message text (+ channel for quote leads). Operator-gated, rate-limited (like the
  other dashboard routes), item-id UUID-validated.
- Routing by source: GHL → `sendSms`/`sendEmail` per the item's channel; quote lead → the customer's GHL
  contact (email by default, SMS if chosen). Gmail items are rejected here (no inline send in v2).
- On success: record the outbound (a `dashboard_activity` entry), then mark Handled via `markItemHandledLocal`
  + `runHandledWriteback` (GHL mark-read + tags). On send failure: return the error; **do not** mark handled.

### 2. AI draft — `POST /api/dashboard/draft`
- Input: inbox item id. Operator-gated, rate-limited. Returns `{ draft: string }`.
- Pure **`buildDraftPrompt(context)`** assembles the system + user prompt from: recent thread (GHL
  `getConversationMessages` by the item's `external_id`) or the quote context (for quote leads), the customer
  name, and the guardrail/voice instructions. Unit-tested (guardrails present; context assembled; no PII leak
  beyond what's needed).
- The route is thin glue over the Anthropic SDK (Sonnet), mirroring `photoAnalysis.ts`'s client usage.

### 3. Reply composer (UI) — in `InboxList` card
- An "AI draft" button, an editable `<textarea>`, and a "Send" button (+ a channel toggle on quote-lead cards).
  "AI draft" calls `/draft` and fills the textarea; the operator edits; "Send" posts to `/reply`. Optimistic
  card update on success (the item drops off the open list, like Handled does today). Gmail cards show the
  "reply in Gmail" hint instead of the composer.

### 4. Layer-3 — "Not a lead" learns the sender
- A suppression list stored in `app_settings` (a new key, e.g. `inbox.suppressedSenders` — no migration).
- The dismiss route ("Not a lead") appends the item's sender (primary email/phone) to the list.
- `classifyMessage` gains an optional `suppressedSenders` set (passed in by the adapter/reconcile so the
  classifier stays pure) → a message whose sender is suppressed classifies as `automated` (auto-hidden).

## Data flow

Operator clicks "AI draft" → `/api/dashboard/draft` builds context (GHL thread / quote) → Sonnet → draft text
in the textarea. Operator edits → "Send" → `/api/dashboard/reply` → GHL send → record activity → mark Handled
→ card clears. Separately, reconcile/poll loads `inbox.suppressedSenders` and passes it to `classifyMessage`,
so suppressed senders ingest as `automated`.

## Error handling / safety

- Human-in-the-loop: nothing sends without an operator clicking Send on text they've seen.
- Guardrails live in the draft system prompt (defense-in-depth) even though the human is the backstop.
- Send failure surfaces inline and leaves the item open (un-handled) so it isn't lost.
- Routes validate the operator session + item id; Gmail items are refused by `/reply` (400) with a clear message.
- AI draft failure (LLM down) returns a friendly error; the operator can still type a reply manually.

## Testing (TDD)

Pure units first: `buildDraftPrompt` (guardrail lines present, thread/quote context assembled, voice/sign-off),
reply channel-routing (GHL sms vs email vs quote-lead email/sms; Gmail → refused), and the suppression check in
`classifyMessage` (suppressed sender → `automated`; unknown → unchanged). Routes stay thin (covered by tsc +
a happy-path/failure route test + review). All gates green (`tsc · lint · vitest`) before merge.

## To confirm during planning (not blockers)

- Exact `highlevel.ts` signatures: `sendSms`, `sendEmail`, `getConversationMessages` (params + how the
  contact/conversation id is sourced from the inbox item / `raw`).
- The Anthropic client setup pattern in `photoAnalysis.ts` (model id, how the key is read) to mirror it.
- The `app_settings` read/write helper (the key already used by portal settings) for the suppression list.
- How the dismiss route resolves the item's sender to append (contact email/phone vs `raw`).
- Whether the suppression list is best matched by email, phone, or both.

## Sequencing

v2 builds on v1. Merge order: **v1 (#258) first** (its migration is already applied to prod), then v2 onto
fresh master. v2 itself needs no migration and no new secrets/scopes.

## Addendum — snooze / "Followed" (2026-06-30, confirmed A + B)

A fourth card action **"Followed"** — snoozes an item (hides it until the customer messages
again), distinct from "Handled" (resolved). Gated: only available once we've followed up.

- **Unlock A:** sending a reply in-tool (the reply route) auto-marks the item Followed.
- **Unlock B:** a manual "I followed up" action (e.g. `POST /api/dashboard/followed`) for phone /
  outside-tool follow-ups — marks Followed without sending anything.
- A Followed item hides from the open list and reappears only on a NEW inbound — relies on the
  reopen-only-on-newer-message fix (PR #262).
- **Data (decide in planning):** a `followed_up_at timestamptz` flag on `inbox_items` (no status-enum
  migration churn) + the open-list query excludes items with `followed_up_at` set (until a newer
  inbound clears/over-rides it), is the leaning option vs. adding a `'followed'` status value.
- **UI:** "Followed" button enabled only after a reply (A); a manual "Mark followed" covers B; a
  "Followed (N)" filter/section surfaces snoozed items.
- Builds after the core v2 reply feature (A depends on reply-inline existing).
