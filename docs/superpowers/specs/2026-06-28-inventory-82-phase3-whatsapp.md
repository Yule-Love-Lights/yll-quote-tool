# Inventory #82 Phase 3 — WhatsApp bot (via Twilio) + AI auto-ordering (notes)

> **Status: BUILT, DORMANT — needs Twilio credentials before it can be switched on.**
> Same pattern as the Valor deposit integration (#38): the code is merged + safe, but does nothing
> until the env config is set and `WHATSAPP_BOT_ENABLED=true`. Until then the webhook just 200s Twilio.
>
> **Originally built for Meta's WhatsApp Cloud API; rewritten for Twilio** when Naldo confirmed
> Twilio is YLL's WhatsApp channel. Twilio signs webhooks with HMAC-SHA1 over URL + sorted form params
> (not Meta's HMAC-SHA256 over body), uses Basic-auth Messages API for sending, and has no `hub.challenge`
> verification handshake.

## What it does
Staff text the YLL Twilio WhatsApp number to manage the **fulfillment board + on-hand stock** from
their phone — no laptop.

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
- `src/lib/integrations/whatsappCommands.ts` — pure command parser (unit-tested; provider-agnostic).
- `src/lib/integrations/whatsapp.ts` — Twilio client: `verifyTwilioSignature` (HMAC-SHA1), sender
  allowlist (strips the `whatsapp:` prefix), `sendWhatsAppText` (Twilio Messages API), and
  `runWhatsAppCommand` (the dispatcher → reads/writes the Slice-3 fulfillment layer + on-hand).
- `src/app/api/integrations/whatsapp/webhook/route.ts` — `POST` handler (form-encoded body, signature
  verified against reconstructed public URL, dispatches the command). `GET` returns plain 200 for ops.
- Allowlisted public path in `src/lib/auth/operatorGate.ts` (Twilio calls it; no operator auth).

## Go-live (Twilio Console + Vercel env vars)
1. **Twilio Console → Messaging → Senders → WhatsApp senders.** Either:
   - **Sandbox** (fast, for testing): activate the WhatsApp sandbox sender. You'll get a sandbox
     number (e.g. `+14155238886`) and a join code. Staff text `join <code>` to opt in.
   - **Production sender** (for real-world use): apply for a WhatsApp sender — requires Meta business
     verification through Twilio. Approval can take days.
2. Click into the sender → "Sender Configuration" → **A MESSAGE COMES IN**:
   - URL: `https://quote.yulelovelights.com/api/integrations/whatsapp/webhook`
   - Method: `HTTP POST`
   - Save.
3. From the Twilio Console **dashboard** (top-right): copy the **Account SID** + **Auth Token**.
4. Set the 4 env vars in Vercel (Project → Settings → Environment Variables):
   - `TWILIO_ACCOUNT_SID` = `AC...`
   - `TWILIO_AUTH_TOKEN` = (the auth token — sensitive)
   - `TWILIO_WHATSAPP_FROM` = `whatsapp:+1...` (the Twilio sender number, full prefix)
   - `WHATSAPP_ALLOWED_NUMBERS` = comma-separated staff E.164 numbers
5. Flip **`WHATSAPP_BOT_ENABLED=true`**, redeploy.
6. From an allowlisted phone, text the Twilio number `help`, then `jobs`. (Sandbox requires the
   recipient to have texted the join code first; staff need to do that once.)

## Why it's dormant, not live
Twilio signature verification + Messages-API round-trip can only be confirmed against a real Twilio
account. The parser, allowlist, and signature algorithm are unit-tested; the network round-trip is
verified at go-live (same as Valor).

## AI auto-ordering
Built and merged: human-gated supplier PO email (#211, `/inventory/orders` → Send) +
unattended cron + event-driven trigger (#213, #218 — every 3 days OR when ≥5 active jobs queued for
materials, both dedup'd). Activated by setting `PO_AUTO_SEND_ENABLED=true` + `THUNDER_ORDER_CONTACT_ID`
in Vercel. See `.env.local.example` for the env shape.
