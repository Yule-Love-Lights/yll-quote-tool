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

## Roles & permissions (from decision #1)

Each allowlist entry maps a Telegram id → a role. Each tool declares a **minimum
role**. The confirm-yes gate applies to sensitive writes **regardless** of role.

| Role | Who | May do |
|---|---|---|
| **crew** | field installers | read schedule / status / inventory; **submit install completion** (photos + material used); move a **job** stage (on-site → installed); capture a **field lead** |
| **office** | office team | everything crew can + **capture/update contacts**, **move the GHL sales pipeline**, **send / nudge** quotes, reporting |
| **admin** | Naldo, Jason | everything + **quote / color / price changes** (money) and settings |

Keep it simple: a `staffId → role` map + a `minRole` on each tool. No per-tool ACL
sprawl. A crew member texting a money command gets a polite "not permitted", logged.

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
| `requestColorChange` | log a color-change against a quote/design | W | admin | Jason area |
| `requestQuoteChange` | open an amend/change-request on a quote | W | admin | Jason area, **money** |

Outbound (bot → staff), reusing `notifyTelegram`:
- deposit paid / new booking · new lead · quote viewed-not-approved nudge · changes
  requested · low stock · a **morning digest** (installs today, quotes to send,
  deposits pending). Highest daily value, lowest risk — barely a build.

## Flagship: `completeInstall` (photos + material used)

Crew, from the field: *"job 142 done"* + photos + *"used 2 boxes C9, 30 clips"*
(typed or **voice note**). The bot:
1. interpreter extracts job#, material lines, and attaches the photos;
2. replies a **confirm** ("Close job #142, log 2×C9 + 30 clips, save 3 photos? yes");
3. on "yes": attaches photos (reuse uploads), **records material actuals**,
   advances the job stage to installed/complete.

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
- **Phase 4 — admin/money writes.** `requestQuoteChange`, `requestColorChange` via
  Jason's amend/color routes. Role: admin. **Coordinate with Jason first.**

Each phase ships behind the existing dormant flags; never a big-bang cutover.

## Guardrails (non-negotiable)

- **Allowlist fail-closed** + **role tiers** — unknown sender ignored; crew can't
  run office/admin tools.
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

## Open items to resolve during the build

1. **`material_actuals` storage** — new column/table shape (per-job SKU + qty +
   optional photo refs). Small migration; column-first per our migration rule.
2. **Voice transcription provider** — which service turns a Telegram voice note
   into text (and language handling).
3. **Photo target** — attach install photos to the job vs. the design vs. both
   (reuse the uploads route either way).
4. **Council?** Worth a council pass right before **Phase 3** (write + CRM model
   locking in). Phases 0–2 are reversible enough to skip it. Ask-first, per policy.
