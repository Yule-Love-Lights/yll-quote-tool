# AI Voice Backup (task #168) — design

**Date:** 2026-07-20
**Owner:** Naldo
**Status:** design approved in conversation, not yet planned or built
**Related:** #169 (manual photo add), #170 (bush/tree AI-vision measurement epic)

## The problem

During peak season (roughly September to December) Yule Love Lights misses about **30 inbound calls and leads per week**. They go to voicemail and are lost. Off-season the volume is negligible, so this is a seasonal problem with a hard deadline.

## The vision this serves

Yule Love Lights wants to be **first to respond and best at keeping up**. Humans stay primary: a customer always reaches a real person first. AI is the backup that catches what the team cannot, eventually across voice, text, and email, so the team spends its time on customer-facing conversation instead of intake.

## Decision: build on VAPI

| Option | Verdict | Why |
|---|---|---|
| **VAPI** | **Chosen** | Premium voice (roughly 536ms end to end on a native TTS provider), a real-time custom-tool contract that can call our own REST API mid-call, and a native GoHighLevel integration so GHL stays the CRM. |
| GoHighLevel Voice AI | Rejected | Naldo has evaluated it. It is underdeveloped and does not meet the brand's standard. Its live-integration path is also a single POST round-trip, not a real function-calling loop. |
| Telnyx | Rejected | Best raw telephony (owns its network) but no native GoHighLevel connector and the heaviest build. We do not need to own telecom for a backup line. |

## Verified facts (checked directly in the GHL account, 2026-07-20)

Recording these so they are not re-litigated later.

1. **External ringing is native, not a workaround.** A GHL number's "Calls Go To" is a **priority-ordered destination list** that includes **`External Phone Number`** ("Route calls to an External Phone Number") alongside `Team Member`, `Voice AI`, and `Business Phone Number`. Naldo's Direct Line (`+1 631-759-4941`) already uses it, routing to `+1 631-740-5980` at 2nd Priority.
2. **There is a separate no-answer backup.** Each number has `Incoming Call Timeout` (currently 20s on most lines) and a **`Back up`** selector whose only choices are **`Voice AI`** or **`Voicemail`**. The backup selector cannot target an external number. This is why the External Phone Number priority slot, not the backup slot, is the route to VAPI.
3. **The main number currently routes into an IVR** ("Yule Love Lights — Main IVR") at 1st Priority.
4. **Call Recording is ON across the numbers checked, and the "Call recording message" field is unchecked and empty.** No recording announcement plays today.
5. The account is **A2P 10DLC compliant**, which matters for the texting leg.

**Still to verify with a live test call (cheap, do before building):** whether 2nd Priority fires on no-answer of 1st Priority, and what the per-priority ring timeout actually is.

## What the AI does, and never does

**Does:**
- Answers when the team does not, plus after hours and overflow.
- Pre-qualifies: service type (curtain, wedding, C9, permanent), colors, rough scope, name, address.
- Gives a **graceful ballpark range** when asked (see below).
- Books an estimate to the GHL calendar.
- Texts the customer from the GHL number asking for photos of the house, trees, or bushes.
- Pushes the captured information into the quote tool as a record that is **ready for staff to start**.
- Transfers to a human on request.

**Never:**
- States or sends a **new** price for a specific house. The pricing engine prices off photos and roofline measurements, and the AI cannot see the house.
- Builds or prices a quote. It hands over intake data, nothing more.
- Sends anything priced. The existing send route stays human-only.
- Denies being AI if asked.

### The ballpark range dodge (required, not optional)

Every caller asks "what does a house like mine run?" A flat refusal reads as robotic and loses the call. The AI gives a **published range with an honest reason it cannot be exact**, for example: "Most homes in your area land somewhere between X and Y depending on the roofline, but I do not want to guess at yours. If you text me a couple of photos we will get you a real number." The range comes from a **fixed, staff-maintained value in the knowledge base**, never from the model's own judgment, and it is explicitly framed as a range, not a quote.

## Voice provider (chosen by ear, not locked)

Naldo asked about Fish Audio as an alternative to ElevenLabs. Checked against VAPI's own docs: Fish Audio is **not** a native VAPI TTS provider (native list is ElevenLabs, Cartesia, Rime, PlayHT, Azure, and a few others). Using it would mean VAPI's "custom TTS" webhook path — we host an endpoint, VAPI posts text to it mid-call, we call Fish Audio and stream audio back. That adds a hop inside the roughly 1.5s latency budget, a new service to host and maintain, and VAPI's own docs recommend keeping a native fallback voice anyway even when using a custom one.

At YLL's call volume (about 30/week at peak) the cost difference between providers is not material — this is not a cost decision. **Decision: stay on a native provider for v1.** ElevenLabs, Cartesia, and Rime all clone a brand voice natively with no custom webhook. Test-call phase (build step 2 below) clones the voice on at least ElevenLabs and Cartesia and picks by ear against the premium bar. Fish Audio stays an option only if no native voice clears that bar, which is not expected.

## Disclosure and recording (settled)

Naldo's "the customer should not know it's AI" meant "the experience should be so smooth they are not frustrated by it", not "conceal it". Concealment is the legal and reputational problem. Disclosure is not.

- **Opening line** names it plainly and warmly, for example: "You've reached Yule Love Lights' automated assistant. I can get your details down and book you in with our team."
- **Never-deny rule:** if asked whether it is AI, it says yes, immediately.
- **Recording announcement:** enable the existing (currently empty) "Call recording message" field. New York is one-party consent so unannounced recording is legal for NY callers, but callers from all-party-consent states (Connecticut, Pennsylvania, Massachusetts, Florida) create exposure. One sentence closes it.

## Architecture

```
Customer calls GHL number
  → Team Member (1st Priority) rings
  → no answer / after hours / busy
  → External Phone Number (2nd Priority) = VAPI number
  → VAPI assistant (native TTS voice — chosen by ear in testing, see Voice provider below — grounded on the knowledge base)
        ├─ discloses, pre-qualifies, range-dodges
        ├─ mid-call tools → new authenticated routes on the quote tool
        ├─ books estimate → GHL calendar (VAPI native GHL tool)
        └─ triggers photo-request text from the GHL number
  → end-of-call webhook
        ├─ transcript + 3-line summary → on-call phone
        ├─ contact + opportunity → GHL (reuse existing helpers)
        └─ instant customer follow-up text/email
  → Voicemail remains the final backup
```

GHL stays the CRM, calendar, and system of record. The quote tool stays the pricing source of truth. VAPI is only the voice layer.

## New code surface

All new routes follow the **Valor webhook posture** already proven in this codebase (`src/app/api/integrations/valor/webhook/route.ts`): read raw body, rate-limit first, fail closed when the secret env var is missing, constant-time compare, service-role Supabase client only after the check passes, idempotent atomic writes.

- `POST /api/integrations/vapi/webhook` — end-of-call events.
- `POST /api/integrations/vapi/tools/*` — mid-call tools: `lookup_customer`, `start_lead`, `request_photos`.
- New env vars: `VAPI_WEBHOOK_SECRET`, VAPI number, assistant id.

**Auth caveat:** do **not** guard these with `requireOperator()`. It is dormant in production unless `AUTH_GATE_ENABLED=true`, so a route "protected" by it is open. VAPI custom tools authenticate with a static secret header rather than an HMAC over the body, so a leaked header is replayable forever. Scope these routes to **create-draft-only**, nothing priced.

**Reused, not rebuilt:** `saveQuote()`, `getQuoteRaw()`, `calculateQuote()`, and the GHL client (`createOpportunity`, `findOrCreateOpportunityForContact`, `searchContacts`, `sendSms`, `sendEmail`). Roughly 70% of the plumbing already exists.

## Photo intake: text, not a custom upload page

The AI (or a GHL workflow) **texts the customer from the GHL number** asking for photos of the house, trees, or bushes. The customer **texts photos back as MMS**, which land in the GHL conversation and flow onward to the quote tool.

This replaces an earlier design that texted a link to a custom upload page. Texting is the better call because it:
- deletes the single largest new build (a customer-facing upload route),
- removes a real security bug (that design would have texted a link containing the quote UUID, which **is** the portal capability token, including approve and decline, to a phone number transcribed from speech),
- matches how customers already behave.

**Known caveat:** carriers compress MMS hard, often to roughly 1 megapixel or less. That is fine for "show me the roofline". It may **not** be enough resolution for the AI-vision bush and tree measurement in #170, which may need a higher-resolution path. Flagged, not solved here.

## Knowledge base (build first)

Distill the thousands of past call transcripts (some in files, some now in GHL) plus service facts (curtain lights, wedding lights, C9, colors, seasons, policy, the published price ranges) into a curated knowledge document fed to the VAPI assistant. **Deliberately not a vector database at first.** Upgrade to retrieval only if plain grounding proves insufficient.

**Before ingestion, scrub PII** (names, addresses, phone numbers). Courts are permitting wiretap claims against AI vendors that transcribe calls on a third-party-listener theory, and repurposing transcripts recorded before AI use was contemplated is a secondary-use problem. Also set a retention limit and contractually bar vendors from training on this data.

## Guardrails

| Risk | Guardrail |
|---|---|
| Money | AI never calls the send, approve, or pay routes. It creates intake records only. A human sends anything priced. |
| Wrong price spoken | Range comes from a fixed staff-maintained KB value, framed as a range, never model-generated. |
| Duplicate leads | `start_lead` idempotent on the VAPI call id (unique constraint plus upsert). Repeat callers matched on phone via `findOrCreateOpportunityForContact` semantics. VAPI retries timed-out tool calls even when the insert succeeded. |
| Bad captures | Per-field confidence marker so staff know what to trust without re-listening to the call. |
| Callback with no context | The 3-line summary goes to the **on-call phone**, not just onto the GHL opportunity. Nobody opens the CRM mid-ring. |
| Latency | Budget is roughly 1.5s of silence before a call feels broken. One DB write per tool handler, defer GHL work to the end-of-call webhook, script filler speech and a "the team will text you" fallback on timeout. |
| PII | Transcripts scrubbed before KB ingestion, access-controlled, retention-limited. |
| Texting consent | Ask permission on the recorded line before texting. Keep automated texts strictly transactional. Include opt-out. TCPA statutory damages run $500 to $1,500 per text. |

## Build order

Small chunks, verified between each, matching the checkpoint cadence that worked on #13.

1. **Verify the routing.** Point External Phone Number (2nd Priority) at a VAPI test number, place test calls, confirm the cascade and timeout. One afternoon, no code.
2. **Knowledge base** plus VAPI assistant on the test number: disclosure, pre-qualify, range dodge, book to GHL calendar, end-of-call transcript and summary. No quote-tool writes yet.
3. **Quote-tool routes** (`lookup_customer`, `start_lead`, `request_photos`) plus the photo-text flow. This lands in Jason's area, so he is looped in before merge.
4. **Cut over** the real number's 2nd Priority to the live VAPI number.

Everything runs against `is_test: true` quotes first, where every downstream side effect (real SMS, email, CRM move, payment webhook) is already a guaranteed no-op.

## Cost

Roughly 30 calls per week at peak, about 4 minutes each, at roughly $0.15 to $0.30 per minute, so about **$20 to $35 per week at peak**, near zero off-season, plus a couple of dollars a month for the number. Trivial against 30 recovered leads per week. Cost is not the constraint.

## Open risks

1. **MMS resolution** may be too low for the #170 measurement work.
2. **Bush and tree measurement from a photo is genuinely hard** because a photo has no inherent scale. Tracked as #170.
3. **Exact GHL priority-cascade semantics** unverified until the test call in step 1.
4. **Voice quality must be listen-tested** against the premium bar before any real customer hears it.

## Council findings carried forward

A five-seat review (customer, staff, technical, compliance, contrarian) produced these, all folded into the design above: the range dodge, the photo-link security bug, the callback context problem, per-field confidence markers, duplicate prevention, the latency budget, PII scrubbing, and the disclosure line.

One council recommendation was **overridden by the operator**: it advised starting on GHL's built-in Voice AI to avoid the build. Naldo has already evaluated that product and rejected it on quality. Recorded here so the argument is not re-run.

## Needs an attorney before launch

Not legal advice. Naldo should have counsel review: the exact greeting script and never-deny rule, the SMS consent capture and message copy, the past-transcript ingestion plan, and the vendor data-processing agreements.
