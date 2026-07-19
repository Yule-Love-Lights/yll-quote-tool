# Text-ops bot + the YLL ops tool layer ("our own MCP")

> Design doc / one-pager, drafted 2026-07-19 for Naldo. Answers two linked
> questions: (1) should YLL build its own MCP, and (2) how do we text WhatsApp /
> Telegram to make the AI quote tool *do things* — request quote changes, take
> contact info, color changes, check inventory, status, move customers in the
> GHL pipeline. **These are the same system.** Not yet a build ticket — a spec to
> react to and phase.

## TL;DR

- We already have a **dormant, security-hardened text bot** (WhatsApp via Twilio +
  Telegram, #82 Phase 3). Webhooks, signature/secret verification, sender
  allowlists, and a provider-agnostic dispatcher are built and tested. Today it
  only does inventory + job-stage moves, via a rigid keyword parser.
- The bot and "our own MCP" are **one system with two layers**:
  1. a **tool layer** — typed functions that DO the work (the "ops tools");
  2. **clients** that call them — the text bot is one client; Claude Code / an
     agent is another; a future web "ask YLL" box is a third.
- **Do NOT lead with MCP-the-protocol.** Build the tool layer first as plain
  internal functions (we already have the skeleton). Wrap it in an actual MCP
  *server* only once a *second* AI client needs the same tools. One consumer =
  no protocol needed; multiple consumers = MCP earns its keep.
- The natural-language part is small: swap the keyword parser for an **LLM
  interpreter** that maps a text message to one tool call. Everything else exists.

## What already exists (the reusable 70%)

| Piece | File | State |
|---|---|---|
| WhatsApp inbound webhook (Twilio, signature-verified) | `src/app/api/integrations/whatsapp/webhook/route.ts` | dormant behind `WHATSAPP_BOT_ENABLED` |
| Telegram inbound webhook (secret-verified, chat allowlist) | `src/app/api/integrations/telegram/webhook/route.ts` | dormant behind `TELEGRAM_BOT_ENABLED` |
| Provider-agnostic dispatch (`handleWhatsAppText`) + runner (`runWhatsAppCommand`) | `src/lib/integrations/whatsapp.ts` | live logic, inventory-only |
| Keyword command parser (to be replaced by LLM) | `src/lib/integrations/whatsappCommands.ts` | pure, unit-tested |
| Sender allowlist + Twilio signature / Telegram secret verify | same files + `src/lib/integrations/telegram.ts` | done |
| GHL client (contact search/fetch, opportunity create/update) | `src/lib/integrations/highlevel.ts` | live in product |
| GHL pipeline stage mapping | `src/lib/integrations/ghlPipelineMap.ts`, `highlevelPipelines.ts` | live |
| Quote status transitions / actions (the legal-move core) | `src/lib/pipeline/pipelineActions.ts` | live |
| Quote amend flow (for "request quote changes") | `src/app/api/quotes/[id]/amend/route.ts` | live (Jason's area) |

**Implication:** we are extending a working bot, not building one. The security
posture (fail-closed allowlist, signed webhooks, dormant-by-default) is already
the right shape — new capabilities inherit it.

## The one idea: tool layer + clients

```
        ┌─────────────── clients (who asks) ───────────────┐
        │  WhatsApp / Telegram bot   Claude Code   web "ask YLL"  │
        └───────────────────────┬───────────────────────────┘
                                │  (each turns a request into a tool call)
                    ┌───────────▼────────────┐
                    │   YLL ops TOOL LAYER    │  ← typed functions, one per capability
                    │  (guards + business     │     read vs write, money/CRM-gated
                    │   rules live here once)  │
                    └───────────┬────────────┘
                    existing API clients / Supabase / GHL
```

- **API vs MCP recap:** an API is code↔code; MCP is agent↔code. An MCP *server*
  is just an adapter that exposes the tool layer to an AI client over a standard
  protocol. It sits ON TOP of the tool layer — it is not a substitute for it.
- **So "should we build our own MCP?"** — build the **tool layer** now (needed
  regardless). Add an **MCP server wrapper** only when a second AI client appears.
  Until then the text bot calls the tool functions directly; no protocol overhead.
- Product money paths (customer approves → invoice → deposit) stay **direct API
  integrations** as today. The tool layer / bot is the *staff-assist* surface,
  never in the customer's automatic money path.

## The YLL ops tools (maps to Naldo's list)

Each is one function in the tool layer. R = read-only, W = write. Writes that
touch money, a customer record, or the CRM require a **confirm step** (see below).

| Tool | Does | R/W | Sensitivity |
|---|---|---|---|
| `status` | "where's the Alvarez quote / job #142?" → stage, $, next action | R | low |
| `checkInventory` | on-hand for a SKU, low-stock list (exists today) | R | low |
| `movePipeline` | advance/append a GHL opportunity to a stage | W | **CRM** |
| `captureContact` | create/update a GHL contact (name, phone, email, address) | W | **CRM** |
| `requestColorChange` | log a color-change request against a quote/design | W | med (Jason area) |
| `requestQuoteChange` | open an amend/change-request on a quote | W | **money** (Jason area) |

Notes:
- `status`, `checkInventory`, `movePipeline` reuse existing code almost as-is.
- `captureContact` reuses `highlevel.ts` contact upsert.
- `requestColorChange` / `requestQuoteChange` are the deepest — they touch the
  quote/design/pricing surface **Jason owns**, so they need his sign-off and
  probably ride his amend + color-change-request routes rather than new logic.

## Message → action pipeline

```
text in ─► webhook (verify signature + allowlist)   [EXISTS]
        ─► LLM interpreter: message → {tool, args, confidence}   [NEW, small]
        ─► if write + sensitive: reply a one-line confirm, wait for "yes"   [NEW]
        ─► run tool (tool layer)   [mostly EXISTS]
        ─► reply result   [EXISTS]
```

The only genuinely new pieces: the **LLM interpreter** (replaces the keyword
parser — one prompt with the tool schemas, returns a structured tool call) and a
**confirm gate** for sensitive writes. Everything else is wiring we already have.

The interpreter is where this connects back to the MCP question: the tool
*schemas* it's given ARE the MCP tool definitions. Write them once; the same
schemas feed the bot's interpreter today and an MCP server later.

## Build phases (crawl → walk → run)

- **Phase 0 — learn, zero code (30 min).** Stand up a Telegram bot (free bot
  token from @BotFather, no business verification), set the allowlist to your
  own chat id, flip `TELEGRAM_BOT_ENABLED` in a **preview** deploy, and text the
  existing inventory commands. Goal: *feel the round-trip* end to end. Telegram
  first because it has zero onboarding friction vs Twilio/WhatsApp business
  approval.
- **Phase 1 — natural-language, READ-ONLY.** Add the LLM interpreter over the
  read tools (`status`, `checkInventory`). No writes = no risk. You can now text
  "how's the Alvarez job?" in plain English. This is the learning milestone.
- **Phase 2 — WRITES with a confirm gate.** `captureContact`, `movePipeline`,
  `requestColorChange`. Each write echoes a one-line confirm ("Move Alvarez →
  Bid Sent? reply yes") before executing. CRM-touching → money/guardrail review.
- **Phase 3 — quote changes (hardest, Jason's area).** `requestQuoteChange`
  rides the existing amend flow. Coordinate with Jason; this is a money surface.

Ship each phase behind the existing dormant flags; never a big-bang cutover.

## Guardrails (non-negotiable)

- **Allowlist stays fail-closed** — only known staff numbers/chat ids, as today.
- **Every sensitive write confirms first** — the LLM can misread intent; a
  one-tap "yes" gate makes a wrong guess harmless. Never auto-execute a money or
  CRM write from a single inferred message.
- **Money/CRM tools log an audit line** (who texted, what ran, what changed).
- **Product money paths untouched** — this is staff-assist, not customer runtime.
- **Interpreter output is validated** against the tool schema before running
  (same discipline as our structured-output workflows) — a low-confidence parse
  asks a clarifying question instead of guessing.

## Ownership / coordination

- Bot infra (`src/lib/integrations/whatsapp|telegram*`, the webhook routes) is
  shared integration code — fine for Naldo to drive.
- **`requestQuoteChange` / `requestColorChange` reach into Jason's area** (quote
  amend, design, pricing). Loop Jason in before Phase 2/3; prefer riding his
  existing routes over new write logic.

## Open decisions (for Naldo)

1. **Telegram-first for learning?** (recommended — zero onboarding vs WhatsApp
   business approval). WhatsApp later for the customer-facing feel.
2. **Who's on the allowlist to start?** (just you, to learn safely.)
3. **Council the write-path architecture** before Phase 2? It's money/CRM-
   adjacent and mostly one-way once staff rely on it — a genuine council
   candidate. Recommendation: not needed for Phase 0/1 (read-only, reversible);
   worth it right before Phase 2 locks the write + confirm model.
4. **Formalize an MCP server** only if/when a second AI client (beyond the bot)
   needs these tools. Until then, tool layer only.
```
