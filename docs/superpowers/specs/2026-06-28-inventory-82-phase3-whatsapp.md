# Inventory #82 Phase 3 — WhatsApp bot (DORMANT) + AI auto-ordering (notes)

> **Status: BUILT, DORMANT — needs a Meta WhatsApp Business account before it can be switched on.**
> Same pattern as the Valor deposit integration (#38): the code is merged + safe, but does nothing
> until the env config is set and `WHATSAPP_BOT_ENABLED=true`. Until then the webhook just 200s Meta.

## What it does
Staff text the YLL WhatsApp Business number to manage the **fulfillment board + on-hand stock** from
their phone — no laptop. Built on **Meta's WhatsApp Cloud API**.

### Command set (case-insensitive; tweak in `src/lib/integrations/whatsappCommands.ts`)
| Text | Action |
|---|---|
| `help` | list commands |
| `jobs` (or `board`) | active jobs + their fulfillment stage |
| `move <job#> <ordered\|pickup\|prepared\|ready>` | set a job's stage (no stock change) |
| `prep <job#>` | mark prepared **& deduct stock** (= the Phase 2 prepare action; → Ready For Install) |
| `stock <sku>` | on-hand for a SKU |
| `set <sku> <qty>` | set a SKU's on-hand count |
| `low` | low-stock items (on-hand ≤ reorder point) |

Replies are plain text. Only **allowlisted staff numbers** (`WHATSAPP_ALLOWED_NUMBERS`) are answered;
everyone else is silently ignored (fails closed).

## Code map
- `src/lib/integrations/whatsappCommands.ts` — pure command parser (unit-tested).
- `src/lib/integrations/whatsapp.ts` — Cloud-API client: signature verify, sender allowlist, send, and
  `runWhatsAppCommand` (the dispatcher → reads/writes the Slice-3 fulfillment layer + on-hand).
- `src/app/api/integrations/whatsapp/webhook/route.ts` — `GET` verification handshake + `POST` events.
- Allowlisted public path in `src/lib/auth/operatorGate.ts` (Meta calls it; no operator auth).

## Go-live (when Naldo has the account)
1. **Meta Business Suite → WhatsApp** → register the business number → note its **Phone Number ID**.
2. In the Meta **app** (Developers → your app → WhatsApp → Configuration):
   - **Callback URL** = `https://quote.yulelovelights.com/api/integrations/whatsapp/webhook`
   - **Verify token** = whatever you set as `WHATSAPP_VERIFY_TOKEN` (e.g. `openssl rand -hex 16`).
   - Click **Verify and save** — our `GET` handler echoes `hub.challenge` (works once the token env is set, even before the bot is enabled).
   - **Subscribe** the webhook to the **`messages`** field.
3. Set the env vars (Vercel + `.env.local`): `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
   (Meta app → Settings → Basic), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_ALLOWED_NUMBERS` (your staff numbers, E.164).
4. Flip **`WHATSAPP_BOT_ENABLED=true`**.
5. From an allowlisted phone, text the number `help`, then `jobs`. (Needs ≥1 deposit-paid job to see cards.)

## Why it's dormant, not live
The webhook signature, send API, and exact Cloud-API wire shapes can only be verified against a real
Meta account (the same reason Valor was built dormant then live-tested). The parser + signature + allowlist
logic are unit-tested; the network round-trip is verified at go-live.

## AI auto-ordering — NOT built (intentionally)
The other half of "Phase 3" needs two things YLL doesn't have a clean interface for yet:
- **A supplier ordering channel.** Does **Thunder Lighting** expose an ordering API, or is it email/portal/manual?
  The order *list* already exists (materials projection + on-hand + the Slice-3 **email-order** button, which
  emails staff the SKUs to order). True auto-ordering needs a supplier endpoint or a confirmed supplier email.
- **A policy call.** Strong recommendation: **AI-drafts an order for staff approval**, never auto-places real
  supplier orders unattended. Revisit once the supplier channel is decided.
