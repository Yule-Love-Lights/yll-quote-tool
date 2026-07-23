# Text-ops bot + the YLL ops tool layer ("our own MCP")

> Design doc / plan, drafted 2026-07-19 for Naldo. Answers two linked questions:
> (1) should YLL build its own MCP, and (2) how do we text WhatsApp / Telegram to
> make the AI quote tool *do things* — request quote changes, take contact info,
> color changes, check inventory, status, move customers in the GHL pipeline, plus
> field capture (install photos + material used). **These are the same system.**
> A spec to react to and phase, not yet a build ticket.

## TL;DR

- We already have a **dormant, security-hardened text bot** (WhatsApp via Twilio +
  Telegram, #82 Phase 3): webhooks, signature/secret verification, a fail-closed
  staff allowlist, a provider-agnostic dispatcher, AND a tested **outbound
  broadcaster** (`notifyTelegram`). Today it only does inventory + job-stage moves
  via a rigid keyword parser.
- The bot and "our own MCP" are **one system, two layers**:
  1. a **tool layer** — typed functions that DO the work (the ops tools);
  2. **clients** that call them — the text bot is one; Claude Code is another; a
     future web assistant is a third.
- **Do NOT lead with MCP-the-protocol.** Build the tool layer first as plain
  internal functions (skeleton exists). Wrap it in an MCP *server* only once a
  *second* AI client needs the same tools. One consumer = no protocol needed.
- The new work is small: swap the keyword parser for an **LLM interpreter** (text
  → one structured tool call), add role tiers + a confirm gate, and add the new
  tools — most reuse existing GHL / amend / uploads / inventory code.

## Decisions locked (Naldo, 2026-07-19)

1. **Users:** Naldo, Jason, office team, **and crew** → needs **role tiers** (a
   crew installer must not move money or the sales pipeline).
2. **Write + read heavy** — writes are first-class, not a someday add-on. We still
   *sequence* writes by risk, but the destination includes real write power.
3. **Confirm model:** every sensitive write echoes a one-line **"reply yes"** gate
   before it executes.
4. **Voice + photos: in scope.** Flagship use: a crew member texts **photos of a
   completed install + how much material it took**, from the field.
5. **Staff only** — no customer-facing bot. → **Telegram** (free, groups, first-
   class bots). WhatsApp/customer-facing is explicitly out of scope.

## What already exists (the reusable 70%)

| Piece | File | State |
|---|---|---|
| WhatsApp inbound webhook (Twilio, signature-verified) | `src/app/api/integrations/whatsapp/webhook/route.ts` | dormant behind `WHATSAPP_BOT_ENABLED` |
| Telegram inbound webhook (secret-verified, chat allowlist) | `src/app/api/integrations/telegram/webhook/route.ts` | dormant behind `TELEGRAM_BOT_ENABLED` |
| Provider-agnostic dispatch + command runner | `src/lib/integrations/whatsapp.ts` | live logic, inventory-only |
| **Outbound broadcaster** (proactive pings) | `src/lib/integrations/telegramNotify.ts` | built + tested |
| Keyword parser (to be replaced by the LLM interpreter) | `src/lib/integrations/whatsappCommands.ts` | pure, unit-tested |
| Staff allowlist + signature/secret verification | webhook files + `src/lib/integrations/telegram.ts` | done, fail-closed |
| GHL client (contact search/fetch, opportunity create/update) | `src/lib/integrations/highlevel.ts` | live in product |
| GHL pipeline stage mapping | `src/lib/integrations/ghlPipelineMap.ts`, `highlevelPipelines.ts` | live |
| Quote status transitions / legal-move core | `src/lib/pipeline/pipelineActions.ts` | live |
| Quote amend flow (for "request quote changes") | `src/app/api/quotes/[id]/amend/route.ts` | live (Jason's area) |
| Photo upload | `src/app/api/uploads/route.ts`, `designs/[id]/photos/route.ts` | live |
| Job materials + stock deduction (**estimate only** — see below) | `src/lib/inventory/jobs.ts` (`prepareJobMaterials`) | live |

**Implication:** we're extending a working bot, not building one. New capabilities
inherit its security posture (fail-closed allowlist, signed webhooks, dormant flags).

## The one idea: tool layer + clients

```
        ┌──────────────── clients (who asks) ────────────────┐
        │  Telegram staff bot     Claude Code     web "ask YLL" │
        └────────────────────────┬────────────────────────────┘
                                 │  (turn a request into a tool call)
                     ┌───────────▼────────────┐
                     │   YLL ops TOOL LAYER    │  ← typed fns; role + confirm gates
                     │  (business rules live    │     live here ONCE
                     │   here once)             │
                     └───────────┬────────────┘
                     existing API clients / Supabase / GHL
```

- **API vs MCP:** an API is code↔code; MCP is agent↔code. An MCP *server* is an
  adapter exposing the tool layer to an AI client — it sits ON TOP of the tool
  layer, not instead of it.
- Product money paths (customer approves → invoice → deposit) stay **direct API
  integrations**. The bot/tool layer is **staff-assist**, never in the customer's
  automatic money path.

## When is an MCP actually warranted? (decision rule)

**Rule:** you need an MCP server when an *interactive AI client — especially one
you don't host — needs to operate your tools.* If the AI is your own product code,
a background processor, or a coding agent touching the repo, it is NOT an MCP
scenario. Common cases:

| Scenario | MCP? | What it actually is |
|---|---|---|
| Claude editing the quote tool's **code** | ❌ No | A coding agent with direct repo/git access |
| Claude editing **data/records** (a quote, inventory) for you | ⚪ Optional | Already possible via the raw **Supabase MCP**; a dedicated YLL MCP just adds business-rule guardrails — worth it only once it's routine |
| The **Telegram text bot** doing things | ❌ Not yet | One AI client → calls the tool layer directly, no protocol needed |
| An **AI voice agent** acting mid-call | ✅ **Yes** | The clearest trigger — a *second* interactive AI client. Build the tool layer once, expose via MCP (or the voice platform's own function-calling) |
| A **third-party AI host** (Claude Desktop, a partner's agent) reaching in | ✅ Yes | External client needs a standard protocol |
| **GHL call transcripts → action items** | ❌ No | A background event pipeline + an LLM extractor (see the related-opportunity section) |

So: build the **tool layer** now (needed regardless); add an **MCP server** the day
a second interactive AI client (voice agent, embedded assistant, outside host)
needs those same tools. The voice system is that day.

## Roles & permissions (from decision #1)

Each allowlist entry maps a Telegram id → a role. Each tool declares a **minimum
role**. The confirm-yes gate applies to sensitive writes **regardless** of role.

| Role | Who | May do |
|---|---|---|
| **crew** | field installers | read schedule / status / inventory; **submit install completion** (photos + material used); move a **job** stage (on-site → installed); capture a **field lead** |
| **office** | office team | everything crew can + **capture/update contacts**, **move the GHL sales pipeline**, **send / nudge** quotes, reporting, **+ quote / color / price changes (money)** — but **NOT settings/config** |
| **admin** | Naldo, Jason | everything + **all settings / configuration** (pricing rules, packages, scheduling, integrations) and **managing the bot itself** (allowlist + roles) |

Keep it simple: a `staffId → role` map + a `minRole` on each tool. No per-tool ACL
sprawl. A crew member texting a money command gets a polite "not permitted", logged.

> **Updated by Naldo (2026-07-19):** office/staff gets money writes (**quote / color
> / price changes**) but **NOT settings / configuration**. All of settings — pricing
> rules, packages, scheduling, integrations — plus **bot administration** (allowlist
> + role assignment) is **admin-only**. That's a real three-tier split: crew → staff
> → admin. The safety model is unchanged: the **confirm-yes gate + audit log** apply
> regardless of role. Full per-permission matrix below.

### Full permission matrix

✓ allowed · — not allowed · ⚑ judgment call (default shown). Staff = office.

| # | Permission | Crew | Staff | Admin |
|---|---|:--:|:--:|:--:|
| **A. Read / visibility** ||||
| 1 | View quote / job status | ✓ | ✓ | ✓ |
| 2 | View today's schedule / next install | ✓ | ✓ | ✓ |
| 3 | View inventory / on-hand / low-stock | ✓ | ✓ | ✓ |
| 4 | View customer contact info (for a job) | ✓ | ✓ | ✓ |
| 5 | View full pipeline board / "what's stuck" | — | ✓ | ✓ |
| 6 | View financials / reporting | — | ✓ | ✓ |
| **B. Field capture** ||||
| 7 | Submit install completion (photos) | ✓ | ✓ | ✓ |
| 8 | Log material actually used | ✓ | ✓ | ✓ |
| 9 | Move a **job** fulfillment stage | ✓ | ✓ | ✓ |
| 10 | Capture a new lead from the field | ✓ | ✓ | ✓ |
| **C. CRM / sales** ||||
| 11 | Create / update a customer contact | — | ✓ | ✓ |
| 12 | Move the GHL **sales** pipeline | — | ✓ | ✓ |
| 13 | Send a quote to a customer | — | ✓ | ✓ |
| 14 | Nudge / remind customers | — | ✓ | ✓ |
| **D. Quote / money** ||||
| 15 | Request a quote change / amend (price) | — | ✓ | ✓ |
| 16 | Request a color change | — | ✓ | ✓ |
| 17 | Apply a price override / discount | — | ✓ | ✓ |
| 18 | Staff-approve / staff-decline for a customer | — | — | ✓ |
| 19 | Convert quote → job / trigger booking | — | ✓ | ✓ |
| **E. Settings / configuration — admin-only** ||||
| 20 | Business settings (pricing rules, packages, colors) | — | — | ✓ |
| 21 | Scheduling / availability windows | — | — | ✓ |
| 22 | Notification / digest preferences | — | — | ✓ |
| 23 | Integration config (API keys, kill-switch flags) | — | — | ✓ |
| **F. Bot administration — owner-only** ||||
| 24 | Add / remove people on the allowlist | — | — | ✓ |
| 25 | Assign / change a person's role | — | — | ✓ |
| 26 | Enable / disable the whole bot | — | — | ✓ |

**Universal (not per-role):** the confirm-yes gate + audit log apply to every
sensitive write regardless of role. **Rows 5, 17, 18 resolved (Naldo, 2026-07-20):**
row 5 crew = no (pipeline board stays staff+); row 17 staff may apply price
overrides / discounts (confirm gate + audit as always); row 18 staff-approve /
staff-decline via the bot is ADMIN-only at launch (in-product staff powers
unchanged; widen later if it proves safe).

## The ops tools (maps to Naldo's list)

R = read, W = write. Sensitive writes (money/CRM/stock) always confirm-yes.

| Tool | Does | R/W | Min role | Notes |
|---|---|---|---|---|
| `status` | "where's the Alvarez quote / job #142?" | R | crew | reuses status core |
| `schedule` | "what's on today / who's my next install?" | R | crew | new read over jobs |
| `checkInventory` | on-hand for a SKU, low-stock (exists today) | R | crew | done |
| `completeInstall` | **flagship** — photos + material used + mark installed | W | crew | see below |
| `captureLead` | new lead from the field (name/phone/address/note) | W | crew | GHL contact create |
| `captureContact` | create/update a GHL contact | W | office | reuses `highlevel.ts` |
| `movePipeline` | advance a GHL opportunity to a stage | W | office | reuses pipeline map |
| `sendOrNudge` | send a quote / nudge viewers who didn't approve | W | office | reuses send routes |
| `requestColorChange` | log a color-change against a quote/design | W | office | Jason area |
| `requestQuoteChange` | open an amend/change-request on a quote | W | office | Jason area, **money** |

Outbound (bot → staff), reusing `notifyTelegram`:
- deposit paid / new booking · new lead · quote viewed-not-approved nudge · changes
  requested · low stock · a **morning digest** (installs today, quotes to send,
  deposits pending). Highest daily value, lowest risk — barely a build.

## Flagship: `completeInstall` (photos + material used)

Crew, from the field: *"job 142 done"* + photos + *"used 2 boxes C9, 30 clips"*
(typed or **voice note**). The bot:
1. interpreter extracts job#, material lines, and attaches the photos;
2. replies a **confirm** ("Close job #142, log 2×C9 + 30 clips, save 3 photos? yes");
3. on "yes": attaches photos (reuse uploads), **records material actuals**.

> **⚠️ Scope correction found during the Phase 2 build (2026-07-22) — step 3 does
> NOT advance the job status.** This plan assumed marking a job installed was a
> stage move. It is not: `POST /api/jobs/[id]/complete` advances the job to
> `requires_invoicing`, **creates the invoice**, moves the GHL pipeline card, and
> can settle the invoice and close the job. That is a money path in Jason's area,
> and it must not fire from a crew member's text off a ladder. The bot therefore
> captures what the field knows (photos + material actually used) and the office
> completes the job in the admin UI as before. Revisit only with Jason, as Phase 4
> work.
>
> **Photo target:** `jobs` has no photo storage — `designs.extra_photos` is the
> only store — so install photos attach to the job's LINKED DESIGN, titled
> "Install photo — job #N". Reachable from the job, and it feeds the design
> history the #155 rebooking wave already wants.
>
> **Stock true-up (Naldo, 2026-07-22):** recording actuals also ADJUSTS on-hand by
> the difference against the estimate deducted at prep. If prep never ran, the
> baseline is zero and the full actual comes off. Test jobs never touch real
> stock; untracked SKUs are recorded but not adjusted; the whole thing is claimed
> once via `jobs.materials_actualized_at`, so a repeated "done" can't double-apply.

**Honest build note:** photos and the stage move **reuse existing infra**.
Recording *actuals* is **new** — today `prepareJobMaterials` deducts only the
**estimated** BOM; nothing captures what was really used. So this needs a small
new write (a per-job `material_actuals` record). Its payoff is big:
- **estimate/pricing accuracy** — variance of actual vs. estimated per job;
- feeds the **dormant BOM engine** (flagged dead code, S23) with real data;
- builds an **install-photo library** (marketing + the #155 "last year's design"
  rebooking already wants these).

Voice + photo are an **input layer** that cuts across tools (any capture command
can accept them); they land with this flagship in Phase 2.

## Message → action pipeline

```
text/voice/photo in ─► webhook (verify signature + allowlist)     [EXISTS]
                    ─► (voice → transcript)                        [NEW, small]
                    ─► LLM interpreter: → {tool, args, confidence} [NEW, small]
                    ─► role check (min role for the tool)          [NEW, small]
                    ─► if sensitive write: reply confirm, await "yes" [NEW]
                    ─► run tool (tool layer)                       [mostly EXISTS]
                    ─► reply result / audit-log the write          [EXISTS + log]
```

The interpreter's tool *schemas* ARE the future MCP tool definitions — write once,
serve the bot now and an MCP server later.

**Optimization — use a cheap model for the interpreter.** Intent-parsing is a
*classification* task, not deep reasoning; route it to a fast, low-cost model
(Haiku-tier) with the tool schemas + forced structured output, returning a
**confidence**. Keeps per-message cost near-zero and latency low. Low confidence →
ask a clarifying question or echo back what it understood, rather than guessing —
the confirm gate is the safety net, this is the first line.

## Build phases (risk-ordered; writes are the destination, not deferred forever)

- **Phase 0 — learn, zero code (30 min).** Telegram bot token from @BotFather,
  allowlist your own chat, flip `TELEGRAM_BOT_ENABLED` on a **preview** deploy,
  text the existing inventory commands. Feel the round-trip.
- **Phase 1 — read + notifications.** LLM interpreter over `status` / `schedule` /
  `checkInventory`, plus the outbound **digest + alerts**. All roles read. No risk.
- **Phase 2 — crew writes (flagship).** `completeInstall` (photos + voice +
  material actuals + stage), `captureLead`. Confirm-gated. Adds the voice/photo
  input layer + the `material_actuals` write. Role: crew+.
- **Phase 3 — office writes.** `captureContact`, `movePipeline`, `sendOrNudge`.
  CRM-touching → confirm-gated + audit log. Role: office+.
- **Phase 4 — money writes.** `requestQuoteChange`, `requestColorChange` via
  Jason's amend/color routes. Role: office+. **Coordinate with Jason first.**

Each phase ships behind the existing dormant flags; never a big-bang cutover.

## Guardrails (non-negotiable)

- **Allowlist fail-closed** + **role tiers** — unknown sender ignored; crew can't
  run office tools; only owners manage the roster.
- **Every sensitive write confirms first** — a misread text is harmless until "yes".
- **Money/CRM/stock writes audit-log** (who, what tool, what changed).
- **Interpreter output validated** against the tool schema; low confidence → ask a
  clarifying question, never guess a write.
- **Bot is a thin remote control** — it never stores its own state or becomes a
  second source of truth; it drives the quote tool / GHL / inventory.
- **Product money paths untouched** — staff-assist only.

## Ownership / coordination

- Bot infra (`integrations/whatsapp|telegram*`, webhooks, the new interpreter +
  tool layer) — Naldo can drive.
- **Phase 4 reaches Jason's area** (quote amend, color, pricing). Loop him in
  before building; ride his existing routes rather than new write logic.

## Related opportunity: GHL call transcripts → action items

Turn every sales/support call into structured follow-ups automatically instead of
relying on memory. **This is NOT an MCP scenario** — the AI is a background
extractor reacting to a webhook (same direct-integration pattern as the rest of the
product, plus one LLM call). It feeds the **same Telegram digest**, so it reinforces
the bot: the transcript pipeline is the *intelligence*, the bot is the *output channel*.

**We're closer than it looks.** The dashboard already ingests GHL conversations
(`src/lib/dashboard/inbox/ghl.ts` + the `/api/dashboard/ghl/webhook` reconcile) and
already recognizes `TYPE_CALL` / `TYPE_VOICEMAIL` as a `call` channel — but calls
currently carry no body, so they show only as "📞 Inbound call". The gap is the
**transcript + the extraction**.

Pipeline:
1. **Get the transcript** — on a call-ended event, pull the call transcript from GHL.
2. **Extract with a cheap LLM** — structured output: `{ action items, follow-ups,
   quote requests, commitments, callback time, sentiment }`, validated.
3. **Route the results** into things that already exist — dashboard **needs-action**
   items + a **Telegram digest ping** ("Call w/ Alvarez: wants the backyard added,
   install by Dec 15 — draft a change?").
4. **Close the loop** — that suggested action becomes a one-tap, confirm-gated bot command.

**Prerequisite to confirm before building:** call recording + transcription is a
paid GHL / Conversation-AI feature — verify it's enabled on the plan and confirm
the transcript-fetch API surface (a quick spike, like the existing
`scripts/spikes/ghl-conversations.ts`). Don't assume the endpoint until verified.

## Open items to resolve during the build

1. **`material_actuals` storage** — new column/table shape (per-job SKU + qty +
   optional photo refs). Small migration; column-first per our migration rule.
2. **Voice transcription provider** — which service turns a Telegram voice note
   into text (and language handling).
3. **Photo target** — attach install photos to the job vs. the design vs. both
   (reuse the uploads route either way).
4. **Council?** Worth a council pass right before **Phase 3** (write + CRM model
   locking in). Phases 0–2 are reversible enough to skip it. Ask-first, per policy.
