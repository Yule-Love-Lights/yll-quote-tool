# AI Voice Backup (#168) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a VAPI voice agent that catches missed/after-hours/overflow calls on YLL's GHL number, pre-qualifies the caller without ever stating a price, books an estimate, and hands staff a lead that's already started — without touching the live number until it's proven on a test number.

**Architecture:** GHL's native `External Phone Number` call-routing priority slot points a test (later: live) VAPI number at a VAPI assistant. The assistant is grounded on a curated knowledge base (chunk 2) and calls a small set of new, signed-webhook-guarded Next.js API routes (chunk 3) that reuse the existing quote/GHL plumbing (`saveQuote`, `findOrCreateOpportunityForContact`, `sendSms`) rather than rebuilding it.

**Tech Stack:** Next.js 15 App Router route handlers, Supabase (service-role client), GoHighLevel API (existing `src/lib/integrations/highlevel.ts` client), VAPI (assistant + custom tools + native GHL tool), vitest.

**Design doc:** `docs/superpowers/specs/2026-07-20-ai-voice-backup-design.md` (approved, PR #1125 open).

---

## Chunk map (matches the design's build order)

| Chunk | Touches Jason's area? | Blocked on? |
|---|---|---|
| 0 — Naldo's account setup | No | Nothing. Naldo does this himself, today. |
| 1 — Verify GHL routing | No | Chunk 0 (needs a VAPI number to point at) |
| 2 — Knowledge base + VAPI assistant config | No | Chunk 0 |
| 3 — Quote-tool API routes + migration | **YES — quotes table + new API routes** | **Jason must be looped in before Task 3.0's first line of code is written, not just before merge.** See the STOP at the top of Chunk 3. |
| 4 — Cutover to the live number | No (config only) | Chunks 1–3 all proven on the test number |

Chunks 0–2 have zero dependency on Chunk 3 and can proceed today. Chunk 3 is written into this plan in full (per "no placeholders") but **must not be executed** until the Chunk 3 STOP is cleared.

---

## Chunk 0: Naldo's account setup — NALDO ACTION, not agent-executable

Claude cannot create accounts or enter payment details on Naldo's behalf (standing rule). These are Naldo's own steps.

- [ ] **0.1 — Sign up for VAPI.** Go to `https://vapi.ai`, create an account, add a payment method. Note the API key (Dashboard → API Keys) — do not paste it into chat; it goes straight into Vercel env vars in Task 3.5.
- [ ] **0.2 — Buy a VAPI test phone number.** VAPI Dashboard → Phone Numbers → Buy/Import. This is the number Chunk 1 points GHL's `External Phone Number` slot at. Keep it separate from whatever number goes live in Chunk 4 if you want a permanent scratch line for future testing.
- [ ] **0.3 — Sign up for ElevenLabs.** `https://elevenlabs.io`, a paid tier that supports voice cloning (Creator tier or above — the free tier's cloning is limited).
- [ ] **0.4 — Sign up for Cartesia.** `https://cartesia.ai`, same reason — Task 2.6 clones the brand voice on both so it can be picked by ear.
- [ ] **0.5 — Record or gather 1–2 minutes of clean voice sample** for whoever's voice gets cloned (Naldo's own, or a staff member's) — a phone recording of a few sentences read naturally, no background noise. Needed for Task 2.6.

---

## Chunk 1: Verify GHL routing

**Files:** none — this is live GHL dashboard configuration + phone testing.

- [ ] **Step 1: Duplicate the routing config onto a safe test surface**

Do NOT touch the live main number (`+1 631-517-0186`) yet. In GHL: `Settings → Phone System → Manage Numbers`, either (a) use one of the existing spare lines (e.g. "Yard Sign Line" or "Door Hanger Line" — currently unused for live customer routing) or (b) buy one new cheap GHL number for this test. Either way, this is the number you'll call to test — not the real main line.

- [ ] **Step 2: Configure the priority list**

On that test number → the ⋮ menu → **Edit Configuration** → **Call Forwarding** tab:
- **1st Priority:** `Team Member` → your own cell, so you're the one answering "as staff" during the test.
- **2nd Priority:** `External Phone Number` → the VAPI number from Task 0.2.
- Leave **Incoming Call Timeout** at the default (20s) for the first test round.

- [ ] **Step 3: Place 5 test calls and log what actually happens**

Call the test number from your own cell (a *different* phone than the "Team Member" one so it doesn't just auto-answer on the same device). Do NOT answer the 1st-priority ring. Time how long it rings before the 2nd priority (VAPI) picks up. Record:
1. Does the VAPI number actually ring/answer on no-answer of 1st priority? (Yes/No — this is the load-bearing fact the whole plan rests on.)
2. Real elapsed time from your call connecting to VAPI answering.
3. Does the default VAPI "assistant" (even an unconfigured placeholder one from Chunk 0) audibly answer, or does it drop the call?

- [ ] **Step 4: Tune the timeout**

If the cascade works but feels slow (callers hate long silent rings), lower **Incoming Call Timeout** to 10–15s and repeat Step 3 twice more to confirm it's still reliable at the shorter window.

- [ ] **Step 5: Record the verified facts back into the design doc**

Edit `docs/superpowers/specs/2026-07-20-ai-voice-backup-design.md`, replace the "Still to verify with a live test call" line under **Verified facts** with the actual measured behavior and timeout chosen. Commit on the `naldo/voice-ai-backup-spec` branch (or a fresh branch off master if that one's already merged):

```bash
git add docs/superpowers/specs/2026-07-20-ai-voice-backup-design.md
git commit -m "docs(voice-ai): #168 verify GHL routing cascade on test number"
```

**Do not proceed to Chunk 4 (live cutover) until this chunk's Step 3 answer to question 1 is a confirmed Yes.**

---

## Chunk 2: Knowledge base v0 + VAPI assistant

**Files:**
- Create: `docs/context/voice-ai-knowledge/services.md`
- Create: `docs/context/voice-ai-knowledge/pricing-ranges.md`
- Create: `docs/context/voice-ai-knowledge/disclosure-and-policy.md`
- Create: `docs/context/voice-ai-knowledge/README.md`

This directory is the "brain" (source-of-truth knowledge, git-versioned, same convention as the rest of `docs/context/`). No vector DB — plain curated markdown, per the design.

- [ ] **Step 1: Write `services.md` — grounded in the real pricing engine types, not guessed**

```markdown
# YLL services (source of truth: src/lib/pricing/pricingEngine.ts, src/lib/serviceType.ts)

## The four service lines (QuoteInputs.serviceType)
- **Holiday** (`holiday`) — seasonal roofline + accessory lighting. Default line of business.
- **Permanent** (`permanent`) — installed year-round smart lighting.
- **Event** (`event`) — temporary lighting for a specific date (weddings, parties). Includes
  bistro/café string lights and barrel/box temporary supports.
- **Bistro** (`permanent_bistro`) — permanent bistro/café lighting installation.

## Roofline patterns (holiday)
- **Santa's** — front roofline only.
- **Gingerbread** — front + ridge/sides (always includes the front component).
- **Winter Wonderland** — a separate lighting style, priced by footage + difficulty.
- **Stake Lighting** — staked ground runs, independent of roofline choice.

## Bulb types (src/lib/design/sceneTypes.ts BulbType)
- `c9` — large traditional bulbs.
- `mini` — mini lights (per-unit items: bushes, trees, railings, etc — this is
  the accessory category that needs a photo, per #170).
- `permanent` — the permanent-lighting bulb/fixture type.
- `bistro` — café string lights (event + bistro verticals).

## Colors
Colors are a LIVE, staff-editable palette (BulbColor), not a fixed list — do not
hardcode specific color names into the AI's script. Ask the caller their color
preference in their own words (warm white, multicolor, a specific holiday
theme, etc) and capture it as free text; staff match it to the real palette.

## Accessories (per-unit items, need a PHOTO — do not attempt to price or count
these on the call; this is exactly the #170 problem)
- Mini light items, spritzers, wreaths, garland, bows, and any custom items.
- **Bushes and trees specifically**: if the caller mentions bushes or trees,
  tell them clearly this needs a photo for an accurate measurement — this is
  a known gap, not a stall tactic. Confirm you'll text them for a photo.

## Add-ons / policy
- Takedown service is available and is its own line item.
- Rush install fee applies unless an early-install promo (Sept/Oct) is active —
  confirm the current promo status with staff before quoting it verbally at all.
```

- [ ] **Step 2: Write `pricing-ranges.md` — the ballpark-range values, PENDING NALDO INPUT**

```markdown
# Ballpark ranges for the AI's range-dodge (NEVER a real quote)

These are the ONLY numbers the voice AI is allowed to speak. They must be a
plain range, always followed by "but I don't want to guess at your specific
house — if you send a couple photos we'll get you a real number." The AI
never computes or invents a number itself; it reads these fixed values.

STATUS: PLACEHOLDER RANGES BELOW — DO NOT USE IN A LIVE ASSISTANT UNTIL
NALDO CONFIRMS REAL NUMBERS. This is deliberately left incomplete rather than
guessed, per the design's money guardrail.

- Holiday, average single-family home: $[NALDO TO FILL] – $[NALDO TO FILL]
- Holiday, larger/complex roofline: $[NALDO TO FILL] – $[NALDO TO FILL]
- Permanent lighting: $[NALDO TO FILL] – $[NALDO TO FILL]
- Event/wedding lighting: $[NALDO TO FILL] – $[NALDO TO FILL]

Last confirmed by Naldo: NEVER — needs a first pass before Chunk 2 Step 5 (the
first test call) can go live with real numbers. Until then, test calls must
use an obviously-fake placeholder range (e.g. "somewhere in the low
thousands") so nobody mistakes a test-call number for a real quoted range.
```

- [ ] **Step 3: Write `disclosure-and-policy.md`**

```markdown
# Disclosure script and the never-deny rule (from the approved design, section
"Disclosure and recording")

## Opening line (verbatim, do not paraphrase away the disclosure)
"You've reached Yule Love Lights' automated assistant. I can get your details
down and book you in with our team."

## If asked "are you a real person?" / "am I talking to AI?" / any variant
Always say yes immediately. Never deny it, deflect, or stay ambiguous. Example:
"Yep, I'm our automated assistant — I can still get you booked in and answer
most questions, and a real person will follow up too."

## The range-dodge (see pricing-ranges.md for the actual numbers)
When asked for a price: give the fixed range from pricing-ranges.md, framed
explicitly as a range, then redirect to photos/booking. Never compute a number.

## What the AI must NEVER do
- State or send a NEW price for a specific house.
- Deny being AI.
- Attempt to build, adjust, or send a quote.
- Promise a specific install date (that's staff's call).

## Recording disclosure
NEEDS TO BE ADDED to the actual call flow once GHL's "Call recording message"
field (currently empty, confirmed in the design doc) is filled in — this is a
GHL Phone Numbers config change, not an AI script change. Track as part of
Chunk 4 (cutover) checklist, not urgent for the test-number chunks.
```

- [ ] **Step 4: Write `README.md` indexing the three docs**

```markdown
# Voice AI knowledge base (v0)

Source of truth for the VAPI assistant's grounding. Plain markdown, no vector
DB (per the #168 design — upgrade only if this proves insufficient).

- [services.md](services.md) — what YLL sells, grounded in the actual pricing
  engine types (not guessed from call transcripts yet — that's the v1 upgrade
  once real transcripts are reviewed).
- [pricing-ranges.md](pricing-ranges.md) — the ONLY numbers the AI may speak.
  **Currently placeholder — Naldo must fill in real ranges before any real
  customer call.**
- [disclosure-and-policy.md](disclosure-and-policy.md) — the disclosure
  script, the never-deny rule, and the range-dodge framing.

## Feeding this into VAPI
Paste the combined contents of all three files into the VAPI assistant's
System Prompt (Dashboard → Assistants → [assistant] → Model → System Prompt),
or upload as Knowledge Base documents if using VAPI's file-based knowledge
feature — decide based on prompt length once assembled; test either way in
Chunk 2 Step 6.

## Keeping it current
This is a living doc, same convention as the rest of docs/context/. When a
test call or real call reveals the AI got something wrong or missing, add it
here and re-paste into the VAPI assistant. No ML retraining involved.
```

- [ ] **Step 5: Commit the knowledge base**

```bash
git add docs/context/voice-ai-knowledge/
git commit -m "docs(voice-ai): #168 knowledge base v0 (services, ranges, disclosure)"
```

- [ ] **Step 6: NALDO ACTION — fill in real pricing ranges**

Edit `pricing-ranges.md` and replace every `$[NALDO TO FILL]` with real staff-approved numbers. This is a money-adjacent value — treat it with the same care as any other pricing decision. Commit the update.

- [ ] **Step 7: NALDO ACTION — create the VAPI assistant on the test number**

VAPI Dashboard → Assistants → Create Assistant:
- **Model:** any VAPI-supported LLM (GPT-4.1 or Claude are both fine for this use case — pick based on what's already configured/cheapest, this isn't a quality-differentiating choice here).
- **Voice:** clone the sample from Task 0.5 on **both** ElevenLabs and Cartesia (VAPI's voice picker lets you select either as the provider once cloned in that provider's own dashboard). Create two versions of the assistant (or one assistant, swap voice provider between test calls) — Step 8 below is where you pick by ear.
- **System Prompt:** paste the assembled knowledge base from Step 4's README instructions.
- **First Message:** the opening line from `disclosure-and-policy.md`, verbatim.
- **Phone Number:** attach the VAPI number from Task 0.2.

- [ ] **Step 8: Place real test calls and pick the voice by ear**

Call the VAPI number directly (not through the GHL cascade yet — that's already proven in Chunk 1). Run through: does it disclose properly, does it hold up under an interruption, does the range-dodge sound natural, does the never-deny rule actually fire when you ask "are you AI?" Compare ElevenLabs vs Cartesia. Pick one. Note the choice in `docs/context/voice-ai-knowledge/README.md`.

- [ ] **Step 9: Configure VAPI's native GHL tool for calendar booking**

VAPI Dashboard → the assistant → Tools → add the native GoHighLevel tool (`docs.vapi.ai/tools/go-high-level`, confirmed available from earlier research). Connect it to the YLL GHL account, configure Check Availability + Create Event against the real GHL calendar. Test: does the assistant actually book a real (or test) calendar slot correctly.

At the end of Chunk 2, you have a fully working disclosure → pre-qualify → range-dodge → calendar-booking assistant on a test number, with **zero quote-tool code**. This alone is a legitimate, demoable milestone.

---

## Chunk 3: Quote-tool API routes + migration

### 🛑 STOP — read before writing a single line in this chunk

Per `AGENTS.md` area ownership, `src/app/api/**` quote-tool routes and the `quotes` table (a SHARED data-layer file) are **Jason's area / need his heads-up first**. This chunk is written out in full below (the plan needs complete code, not placeholders) but:

- [ ] **Task 3.0 — Loop in Jason before executing anything else in this chunk.** Share this plan file + the design doc with him. Get his explicit go on the new migration and the new route files below. Do not let a subagent or the executing-plans flow proceed past this checkbox unattended.

Everything below assumes Task 3.0 is cleared.

**Files:**
- Create: `migrations/2026-07-2X-quotes-add-vapi-call-id.sql`
- Create: `src/lib/integrations/vapi.ts`
- Create: `src/lib/integrations/vapi.test.ts`
- Create: `src/app/api/integrations/vapi/tools/lookup-customer/route.ts`
- Create: `src/app/api/integrations/vapi/tools/lookup-customer/route.test.ts`
- Create: `src/app/api/integrations/vapi/tools/start-lead/route.ts`
- Create: `src/app/api/integrations/vapi/tools/start-lead/route.test.ts`
- Create: `src/app/api/integrations/vapi/webhook/route.ts`
- Create: `src/app/api/integrations/vapi/webhook/route.test.ts`

Photo intake (`request_photos`) is deliberately **not** a new route — per the design, photos come in as an MMS reply to a plain GHL text, which already lands in the GHL conversation with no new code. If a "trigger the photo-request text" tool ends up needed, it's a thin wrapper around the existing `sendSms` helper, same pattern as `start-lead` below — add it after Chunk 3's other three routes are proven, not before.

### Task 3.1: The migration — `vapi_call_id` for idempotency

- [ ] **Step 1: Write the migration**

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `vapi_call_id` to quotes (#168 AI voice backup)
-- ─────────────────────────────────────────────────────────────────────────
-- VAPI retries a tool call that times out even when the underlying insert
-- already succeeded. start_lead uses this column as its idempotency key: a
-- unique constraint means a retried insert with the same call id fails
-- cleanly and the route falls back to a lookup instead of creating a
-- duplicate draft quote. Nullable — only quotes created by the voice agent
-- carry a value; every other creation path (the quote builder, rebook,
-- self-serve) leaves it null.
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS,
-- per CONVENTIONS.md §6 (model: migrations/2026-06-28-quotes-add-is-test.sql).

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS vapi_call_id text;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_vapi_call_id_idx
  ON quotes (vapi_call_id)
  WHERE vapi_call_id IS NOT NULL;
```

- [ ] **Step 2: Apply it the same way the repo's other migrations get applied**

Per `docs/context/project_apply_migrations_via_browser.md` (Supabase MCP is DDL-read-only) — apply via the Supabase SQL editor in the browser, or however Jason/Naldo currently apply migrations to this project. Confirm the column + index exist with a `list_tables`/`execute_sql` check before moving to Task 3.2.

- [ ] **Step 3: Commit**

```bash
git add migrations/2026-07-2X-quotes-add-vapi-call-id.sql
git commit -m "feat(db): #168 add quotes.vapi_call_id for voice-agent idempotency"
```

### Task 3.2: `src/lib/integrations/vapi.ts` — config + secret verification

Mirrors the shape of `src/lib/integrations/valor.ts`'s `isValorConfigured`/`verifyWebhookSignature`, but VAPI's server-tool auth is a **static secret header**, not HMAC (confirmed in the design doc) — verify the exact header name against `docs.vapi.ai` when configuring the assistant's Server URL in Chunk 2/3 crossover (VAPI lets you set a "Server URL Secret" that arrives on a documented header; treat `x-vapi-secret` below as the working assumption and correct it in Step 1 if the live docs show a different name before this ships).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/integrations/vapi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('vapi integration config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('isVapiConfigured is false when the secret env var is missing', async () => {
    vi.stubEnv('VAPI_WEBHOOK_SECRET', '');
    const { isVapiConfigured } = await import('./vapi');
    expect(isVapiConfigured()).toBe(false);
  });

  it('isVapiConfigured is true when the secret env var is set', async () => {
    vi.stubEnv('VAPI_WEBHOOK_SECRET', 'test-secret-123');
    const { isVapiConfigured } = await import('./vapi');
    expect(isVapiConfigured()).toBe(true);
  });

  it('verifyVapiSecret rejects a missing header', () => {
    expect(
      verifyVapiSecretForTest({ headerValue: null, secret: 'test-secret-123' }),
    ).toBe(false);
  });

  it('verifyVapiSecret rejects a wrong header', () => {
    expect(
      verifyVapiSecretForTest({ headerValue: 'wrong', secret: 'test-secret-123' }),
    ).toBe(false);
  });

  it('verifyVapiSecret accepts the correct header', () => {
    expect(
      verifyVapiSecretForTest({ headerValue: 'test-secret-123', secret: 'test-secret-123' }),
    ).toBe(true);
  });
});

// Re-exported below purely so this test file can import the pure function
// without going through the env-var-dependent module init.
function verifyVapiSecretForTest(input: { headerValue: string | null; secret: string }) {
  const { verifyVapiSecret } = require('./vapi');
  return verifyVapiSecret(input);
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/integrations/vapi.test.ts`
Expected: FAIL — `Cannot find module './vapi'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/lib/integrations/vapi.ts
//
// Config + auth helpers for the VAPI voice-agent integration (#168). Mirrors
// the posture of src/lib/integrations/valor.ts, adapted for VAPI's
// static-secret-header auth (not HMAC) on custom-tool and webhook requests.

export function isVapiConfigured(): boolean {
  return !!process.env.VAPI_WEBHOOK_SECRET;
}

// Constant-time-ish compare (matches the intent of the Valor safeEqual
// pattern) — avoids a short-circuit string === that leaks timing info on the
// secret. Simple length+char loop is sufficient here (this is not a
// cryptographic primitive in the Node crypto sense, just avoiding the most
// obvious timing leak on a low-value shared secret).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyVapiSecret(input: { headerValue: string | null; secret: string }): boolean {
  const { headerValue, secret } = input;
  if (!headerValue || !secret) return false;
  return safeEqual(headerValue, secret);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/lib/integrations/vapi.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/vapi.ts src/lib/integrations/vapi.test.ts
git commit -m "feat(voice-ai): #168 vapi.ts config + secret verification"
```

### Task 3.3: `lookup_customer` tool route

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/integrations/vapi/tools/lookup-customer/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { searchContacts } = vi.hoisted(() => ({
  searchContacts: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@/lib/integrations/highlevel', () => ({ searchContacts }));

function makeReq(body: unknown, secret: string | null): NextRequest {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => (k.toLowerCase() === 'x-vapi-secret' ? secret : null) },
  } as unknown as NextRequest;
}

describe('POST /api/integrations/vapi/tools/lookup-customer', () => {
  beforeEach(() => {
    vi.stubEnv('VAPI_WEBHOOK_SECRET', 'test-secret-123');
    searchContacts.mockClear();
  });

  it('rejects a request with no secret header', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ toolCallId: 't1', arguments: { phone: '+16315551212' } }, null));
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ toolCallId: 't1', arguments: { phone: '+16315551212' } }, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('returns the VAPI tool-result envelope on a match', async () => {
    searchContacts.mockResolvedValueOnce([
      { id: 'contact-1', name: 'Jordan Smith', phone: '+16315551212' },
    ] as never);
    const { POST } = await import('./route');
    const res = await POST(
      makeReq({ toolCallId: 't1', arguments: { phone: '+16315551212' } }, 'test-secret-123'),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results[0].toolCallId).toBe('t1');
    expect(json.results[0].result).toContain('Jordan Smith');
  });

  it('returns a not-found result (still 200, per VAPI tool-call contract) with no match', async () => {
    searchContacts.mockResolvedValueOnce([] as never);
    const { POST } = await import('./route');
    const res = await POST(
      makeReq({ toolCallId: 't1', arguments: { phone: '+15550000000' } }, 'test-secret-123'),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results[0].result).toContain('no existing customer');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/app/api/integrations/vapi/tools/lookup-customer/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/app/api/integrations/vapi/tools/lookup-customer/route.ts
//
// VAPI custom tool: mid-call lookup of an existing GHL contact by phone, so
// the assistant knows whether it's talking to a returning customer before
// deciding what to say. Read-only — never creates or modifies anything.
//
// Request (from VAPI, docs.vapi.ai/tools/custom-tools):
//   { toolCallId: string, arguments: { phone: string } }
// Response (VAPI's required tool-result envelope):
//   { results: [{ toolCallId, result: string }] }

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isVapiConfigured, verifyVapiSecret } from '@/lib/integrations/vapi';
import { searchContacts } from '@/lib/integrations/highlevel';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const limited = rateLimitResponse(req, { bucket: 'vapi-tools', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!isVapiConfigured()) {
    return NextResponse.json({ error: 'vapi integration not configured' }, { status: 503 });
  }

  const secretOk = verifyVapiSecret({
    headerValue: req.headers.get('x-vapi-secret'),
    secret: process.env.VAPI_WEBHOOK_SECRET!,
  });
  if (!secretOk) {
    return NextResponse.json({ error: 'invalid secret' }, { status: 401 });
  }

  const rawBody = await req.text();
  let body: { toolCallId?: string; arguments?: { phone?: string } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const toolCallId = body.toolCallId ?? '';
  const phone = body.arguments?.phone?.trim();
  if (!phone) {
    return NextResponse.json({
      results: [{ toolCallId, result: 'No phone number provided.' }],
    });
  }

  const matches = await searchContacts(phone);
  const result =
    matches.length > 0
      ? `Found existing customer: ${matches[0].name ?? 'unnamed'}, contact id ${matches[0].id}.`
      : 'No existing customer found for this number — treat as a new lead.';

  return NextResponse.json({ results: [{ toolCallId, result }] });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/app/api/integrations/vapi/tools/lookup-customer/route.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/integrations/vapi/tools/lookup-customer/
git commit -m "feat(voice-ai): #168 lookup_customer VAPI tool route"
```

### Task 3.4: `start_lead` tool route — the idempotent draft-quote creator

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/integrations/vapi/tools/start-lead/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { saveQuote, findOrCreateOpportunityForContact } = vi.hoisted(() => ({
  saveQuote: vi.fn(async () => ({ id: 'quote-new-1' })),
  findOrCreateOpportunityForContact: vi.fn(async () => ({
    opportunity: { id: 'opp-1' },
    created: true,
  })),
}));

const sbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/quotes', () => ({ saveQuote }));
vi.mock('@/lib/integrations/highlevel', () => ({ findOrCreateOpportunityForContact }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

function makeReq(body: unknown, secret: string | null): NextRequest {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => (k.toLowerCase() === 'x-vapi-secret' ? secret : null) },
  } as unknown as NextRequest;
}

describe('POST /api/integrations/vapi/tools/start-lead', () => {
  beforeEach(() => {
    vi.stubEnv('VAPI_WEBHOOK_SECRET', 'test-secret-123');
    vi.stubEnv('HIGHLEVEL_PIPELINE_ID', 'pipeline-1');
    vi.stubEnv('HIGHLEVEL_STAGE_QUOTE_CREATED', 'stage-1');
    saveQuote.mockClear();
    findOrCreateOpportunityForContact.mockClear();
    sbRef.current = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    };
  });

  it('rejects an unsigned request', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq({ toolCallId: 't1', arguments: { callId: 'call-1', name: 'Jordan Smith' } }, null),
    );
    expect(res.status).toBe(401);
  });

  it('creates a draft quote as is_test:false with the captured intake fields', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        {
          toolCallId: 't1',
          arguments: {
            callId: 'call-abc-123',
            name: 'Jordan Smith',
            phone: '+16315551212',
            address: '12 Holly Ln, Amityville NY',
            serviceType: 'holiday',
            notes: 'Wants Gingerbread roofline, warm white, mentioned two large bushes',
          },
        },
        'test-secret-123',
      ),
    );
    expect(res.status).toBe(200);
    expect(saveQuote).toHaveBeenCalledTimes(1);
    const [customerArg, , , serviceTypeArg] = saveQuote.mock.calls[0];
    expect(customerArg.name).toBe('Jordan Smith');
    expect(serviceTypeArg).toBe('holiday');
    const json = await res.json();
    expect(json.results[0].toolCallId).toBe('t1');
  });

  it('is idempotent on callId — a retry with the same callId does not create a second quote', async () => {
    // Simulate the unique-index conflict path: the first lookup-by-vapi_call_id
    // finds the row already created by the earlier (successful but
    // slow-to-ack) attempt.
    sbRef.current = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: 'quote-existing-1' }, error: null }),
          }),
        }),
      }),
    };
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        {
          toolCallId: 't2',
          arguments: { callId: 'call-abc-123', name: 'Jordan Smith', phone: '+16315551212' },
        },
        'test-secret-123',
      ),
    );
    expect(res.status).toBe(200);
    expect(saveQuote).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.results[0].result).toContain('already started');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/app/api/integrations/vapi/tools/start-lead/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/app/api/integrations/vapi/tools/start-lead/route.ts
//
// VAPI custom tool: creates a DRAFT quote from what the caller told the
// assistant, and links/creates the matching GHL opportunity. This is the
// "quote already started before staff sees the missed call" seam from the
// design. NEVER touches pricing, NEVER sends anything — draft only.
//
// Idempotency: keyed on VAPI's own call id (arguments.callId), stored in the
// new quotes.vapi_call_id column (unique index, migration
// 2026-07-2X-quotes-add-vapi-call-id.sql). A retried tool call with the same
// callId is detected by a lookup BEFORE insert and returns the existing
// quote instead of creating a duplicate — VAPI retries timed-out tool calls
// even when the original insert already succeeded (see design doc's
// "Duplicate leads" guardrail).

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isVapiConfigured, verifyVapiSecret } from '@/lib/integrations/vapi';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { saveQuote } from '@/lib/quotes';
import { findOrCreateOpportunityForContact } from '@/lib/integrations/highlevel';
import { asServiceType, DEFAULT_SERVICE_TYPE } from '@/lib/serviceType';
import type { QuoteInputs, QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

// A start_lead draft carries NO measurements yet (the AI never sees the
// house) — every footage field is 0. calculateQuote still needs a valid
// QuoteInputs/QuoteResult shape to satisfy saveQuote's signature, so this is
// the deliberately-empty "not yet priced" skeleton staff fill in for real.
const EMPTY_INPUTS: QuoteInputs = {
  santasFootage: 0,
  santasDifficulty: 'easy',
  gingerbreadFootage: 0,
  gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'easy',
  stakeLightingFootage: 0,
  stakeLightingDifficulty: 'easy',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'none',
  rushFee: false,
};

const EMPTY_RESULT: QuoteResult = {
  lineItems: [],
  subtotal: 0,
  discountAmount: 0,
  rushFeeAmount: 0,
  taxAmount: 0,
  total: 0,
  depositAmount: 0,
} as unknown as QuoteResult; // draft-only skeleton — staff re-Calculate before send

export async function POST(req: NextRequest) {
  const limited = rateLimitResponse(req, { bucket: 'vapi-tools', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!isVapiConfigured() || !isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  const secretOk = verifyVapiSecret({
    headerValue: req.headers.get('x-vapi-secret'),
    secret: process.env.VAPI_WEBHOOK_SECRET!,
  });
  if (!secretOk) {
    return NextResponse.json({ error: 'invalid secret' }, { status: 401 });
  }

  const rawBody = await req.text();
  let body: {
    toolCallId?: string;
    arguments?: {
      callId?: string;
      name?: string;
      phone?: string;
      address?: string;
      serviceType?: string;
      notes?: string;
    };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const toolCallId = body.toolCallId ?? '';
  const args = body.arguments ?? {};
  const callId = args.callId?.trim();
  if (!callId) {
    return NextResponse.json({
      results: [{ toolCallId, result: 'Missing callId — cannot start a lead safely without it.' }],
    });
  }

  const sb = getSupabaseServiceClient();
  if (!sb) return NextResponse.json({ error: 'no service client' }, { status: 503 });

  // Idempotency check FIRST — see file header.
  const existing = await sb
    .from('quotes')
    .select('id')
    .eq('vapi_call_id', callId)
    .maybeSingle();
  if (existing.data) {
    return NextResponse.json({
      results: [
        {
          toolCallId,
          result: `A lead for this call is already started (quote ${existing.data.id}) — no duplicate created.`,
        },
      ],
    });
  }

  const serviceType = asServiceType(args.serviceType) ?? DEFAULT_SERVICE_TYPE;
  const saved = await saveQuote(
    { name: args.name, phone: args.phone, address: args.address },
    EMPTY_INPUTS,
    EMPTY_RESULT,
    serviceType,
    false, // is_test — a real voice-agent lead is a real lead, not test data
    null, // createdBy — no operator session on a voice-agent-originated quote
  );
  if (!saved) {
    return NextResponse.json({
      results: [{ toolCallId, result: 'Could not save the lead — a human will need to enter it manually.' }],
    });
  }

  // Stamp the idempotency key onto the row we just created.
  await sb.from('quotes').update({ vapi_call_id: callId }).eq('id', saved.id);

  // Best-effort GHL link — the draft quote already exists even if this fails.
  try {
    const contactSearch = args.phone
      ? await import('@/lib/integrations/highlevel').then((m) => m.searchContacts(args.phone!))
      : [];
    const contactId = contactSearch[0]?.id;
    if (contactId && process.env.HIGHLEVEL_PIPELINE_ID && process.env.HIGHLEVEL_STAGE_QUOTE_CREATED) {
      await findOrCreateOpportunityForContact({
        contactId,
        pipelineId: process.env.HIGHLEVEL_PIPELINE_ID,
        fallbackStageId: process.env.HIGHLEVEL_STAGE_QUOTE_CREATED,
        fallbackName: args.name ?? 'Voice AI lead',
        source: 'vapi-voice-agent',
      });
    }
  } catch (err) {
    console.error('[vapi/start-lead] GHL link failed (non-fatal):', err);
  }

  return NextResponse.json({
    results: [
      {
        toolCallId,
        result: `Started a draft quote for ${args.name ?? 'the caller'} — staff will follow up to finish pricing.`,
      },
    ],
  });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/app/api/integrations/vapi/tools/start-lead/route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/integrations/vapi/tools/start-lead/
git commit -m "feat(voice-ai): #168 start_lead VAPI tool route (idempotent draft quote)"
```

### Task 3.5: End-of-call webhook — transcript, on-call notify, follow-up text

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/integrations/vapi/webhook/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn(async () => ({})) }));
vi.mock('@/lib/integrations/highlevel', () => ({ sendSms }));

function makeReq(body: unknown, secret: string | null): NextRequest {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => (k.toLowerCase() === 'x-vapi-secret' ? secret : null) },
  } as unknown as NextRequest;
}

describe('POST /api/integrations/vapi/webhook', () => {
  beforeEach(() => {
    vi.stubEnv('VAPI_WEBHOOK_SECRET', 'test-secret-123');
    vi.stubEnv('ON_CALL_STAFF_PHONE_CONTACT_ID', 'staff-contact-1');
    sendSms.mockClear();
  });

  it('rejects an unsigned request', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ type: 'end-of-call-report' }, null));
    expect(res.status).toBe(401);
  });

  it('ignores non end-of-call event types (200 no-op)', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ type: 'status-update' }, 'test-secret-123'));
    expect(res.status).toBe(200);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('texts the on-call staff a summary on an end-of-call-report event', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        {
          type: 'end-of-call-report',
          call: { id: 'call-abc-123' },
          summary: 'Caller wants holiday lighting, Gingerbread roofline, warm white.',
          transcript: 'AI: You have reached... Caller: Hi I would like...',
        },
        'test-secret-123',
      ),
    );
    expect(res.status).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [callArg] = sendSms.mock.calls[0];
    expect(callArg.message).toContain('Gingerbread');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/app/api/integrations/vapi/webhook/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/app/api/integrations/vapi/webhook/route.ts
//
// VAPI end-of-call webhook (#168). On an 'end-of-call-report' event, texts a
// 3-line summary to the on-call staff phone DIRECTLY — per the design's
// "Callback with no context" guardrail, nobody opens GHL mid-ring, so the
// summary has to land where staff are actually looking: their phone.
//
// VAPI sends several event `type`s to the same Server URL (status-update,
// transcript, end-of-call-report, ...) — this route only acts on
// end-of-call-report and 200-acks everything else as a no-op.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isVapiConfigured, verifyVapiSecret } from '@/lib/integrations/vapi';
import { sendSms } from '@/lib/integrations/highlevel';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const limited = rateLimitResponse(req, { bucket: 'vapi-webhook', limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  if (!isVapiConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  const secretOk = verifyVapiSecret({
    headerValue: req.headers.get('x-vapi-secret'),
    secret: process.env.VAPI_WEBHOOK_SECRET!,
  });
  if (!secretOk) {
    return NextResponse.json({ error: 'invalid secret' }, { status: 401 });
  }

  const rawBody = await req.text();
  let event: { type?: string; call?: { id?: string }; summary?: string; transcript?: string };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (event.type !== 'end-of-call-report') {
    return NextResponse.json({ ok: true, noop: true });
  }

  const onCallContactId = process.env.ON_CALL_STAFF_PHONE_CONTACT_ID;
  if (onCallContactId && event.summary) {
    try {
      await sendSms({
        contactId: onCallContactId,
        message: `Voice AI call ${event.call?.id ?? ''}: ${event.summary}`.slice(0, 1500),
      });
    } catch (err) {
      // Best-effort — the call already happened; a failed notify text must
      // never turn into a 500 that makes VAPI retry the whole webhook.
      console.error('[vapi/webhook] on-call notify failed:', err);
    }
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/app/api/integrations/vapi/webhook/route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/integrations/vapi/webhook/
git commit -m "feat(voice-ai): #168 end-of-call webhook (on-call staff notify)"
```

### Task 3.6: Env vars + Vercel config

- [ ] **Step 1: Add to `.env.local` (dev) and Vercel project env (prod/preview)**

```
VAPI_WEBHOOK_SECRET=<the Server URL Secret configured in the VAPI assistant>
ON_CALL_STAFF_PHONE_CONTACT_ID=<the GHL contact id that should receive call-summary texts>
```

`HIGHLEVEL_PIPELINE_ID` and `HIGHLEVEL_STAGE_QUOTE_CREATED` already exist in this repo (used by `start-lead`'s GHL link) — confirm they're set, don't duplicate.

- [ ] **Step 2: In the VAPI dashboard, point the assistant's Server URL + tools at the deployed routes**

Server URL (end-of-call events): `https://<your-vercel-domain>/api/integrations/vapi/webhook`
Custom tools: `https://<your-vercel-domain>/api/integrations/vapi/tools/lookup-customer` and `/start-lead`, each with the Server URL Secret header configured to match `VAPI_WEBHOOK_SECRET`.

- [ ] **Step 3: Run the full gate suite before this chunk is considered done**

```bash
npx tsc --noEmit
npm run lint
npm test
```

All three must be green. This is a customer-facing, money-adjacent surface (per `AGENTS.md`'s review-gates policy) — before asking for a merge-go, run the four-lens review (customer/staff/admin/technical) same as any other PR touching the quote builder or pricing seams.

- [ ] **Step 4: End-to-end test on the VAPI test number with `is_test` quotes**

Before touching the live number, call the Chunk 1 test number, go through a full intake, and confirm: a draft quote actually appears in the quote tool, the GHL opportunity links correctly, the on-call text arrives with the right summary, and calling twice with a dropped/retried tool call does NOT create a duplicate quote (this is the one to actually try to break — hang up mid-call, call back, see what happens).

---

## Chunk 4: Cutover to the live number

**Only after Chunks 1–3 are fully proven on the test number.**

- [ ] **Step 1: Turn on the GHL call-recording announcement** — `Settings → Phone System → [live main number] → Call Forwarding → Call recording message`. Fill in a one-line disclosure per the design doc's compliance section (has this been reviewed by an attorney per the design's "Needs an attorney before launch" section? — confirm before this step, not after).
- [ ] **Step 2: Point the live number's 2nd Priority at the real VAPI production number** (same `External Phone Number` config proven in Chunk 1, now on `+1 631-517-0186` instead of the test number).
- [ ] **Step 3: Watch the first few real calls closely** — on-call staff should treat the first week as a monitored pilot, not fire-and-forget.

---

## Self-review (per writing-plans skill)

**1. Spec coverage** — every section of the design doc maps to a task: routing verification → Chunk 1; knowledge base + voice pick + disclosure/never-deny/range-dodge → Chunk 2; new code surface + guardrails (money, duplicate leads, callback context, PII, latency) → Chunk 3; cutover + recording announcement → Chunk 4. The one design item deliberately deferred is `request_photos` as its own tool route — the design itself says photo intake is a plain text/MMS reply requiring no new code, so there is nothing to build there yet; noted explicitly in Chunk 3's file list rather than silently dropped.

**2. Placeholder scan** — the only intentional placeholders are `pricing-ranges.md`'s `$[NALDO TO FILL]` values, which are money-adjacent and correctly gated behind a NALDO ACTION step rather than invented.

**3. Type consistency** — `saveQuote`'s call signature (customer, inputs, result, serviceType, isTest, createdBy) matches `src/lib/quotes.ts:174` exactly across Task 3.4. `findOrCreateOpportunityForContact`'s input shape matches `src/lib/integrations/highlevel.ts:213`. `searchContacts(query, limit?)` matches `:83`. `rateLimitResponse(req, opts)` matches `src/lib/rateLimit.ts:101`.
