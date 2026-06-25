---
name: project-valor-golive
description: Go-live runbook for the ValorPay deposit integration (#38). The exact step-by-step to take payments live once Valor sends the webhook secret. Plain-English human steps + technical verification + the CONFIRM checklist + rollback.
metadata:
  node_type: memory
  type: project
---

# ValorPay go-live runbook (#38)

> The payment code is **built, reviewed, tested, and merge-ready** on branch
> `claude/valorpay-payment-integration-49fswx` (PR #84). It is **parked** —
> nothing is live — until Valor sends the webhook secret and we run a staging
> test. This is the click-by-click to flip it on safely. **Handles real
> customer money — do the staging test before production.**

## Where things stand (as of S13)
- ✅ Code merged-ready against master; gates green (tsc · lint · full suite · build).
- ✅ Prod DB migration applied (`2026-06-24-quotes-add-valor-payment.sql`).
- ✅ `VALOR_APP_ID` / `VALOR_APP_KEY` / `VALOR_EPI` set in Vercel.
- ✅ `VALOR_IS_DEMO` defaults **true** → all traffic hits Valor **staging** until explicitly flipped.
- ⏳ **Blocked on:** the Valor **webhook signing secret** (Naldo emailed Valor support to enable webhooks + issue it).

---

## STEP 1 — Naldo (when Valor replies)
1. In the Valor email, get the **webhook signing secret**.
2. **Vercel → yll-quote-tool → Settings → Environment Variables**, add:
   - `VALOR_WEBHOOK_SECRET` = (the secret) — apply to **Production *and* Preview**.
3. Give Valor support this **webhook URL** so they POST confirmations to us:
   - `https://quote.yulelovelights.com/api/integrations/valor/webhook`
4. (Optional) add `HIGHLEVEL_STAGE_QUOTE_APPROVED` = `90e7a535-689c-441e-b759-d16742bbd5a9`
   (if unset, the webhook falls back to the SIGNED stage id — same stage, still works).
5. **Redeploy** (env vars only bake in on a new deploy), then tell Claude "the secret's in."

> Leave `VALOR_IS_DEMO=true` for now — we test on **staging** first.

## STEP 2 — Claude: staging end-to-end test (still `VALOR_IS_DEMO=true`)
On the **preview/staging** deployment, with a throwaway test quote:
1. Open the quote portal → **Approve** → the embedded Passage.js card form opens.
2. Pay the deposit with a **Valor staging test card** (get the test card numbers from
   Valor's docs / staging dashboard — they are NOT in this repo).
3. Confirm the **webhook fires** and the quote flips to **booked**: `deposit_paid_at`
   stamped, HighLevel card moved to ⏰Approved, **receipt** SMS+email sent, internal
   "deposit received" email sent.
4. **Confirm every `CONFIRM:` seam** against what Valor actually sent (see checklist
   below) and fix any mismatch in `src/lib/integrations/valor.ts` /
   `DepositCheckout.tsx`. Re-run gates.

The local sandbox test (`webhook/route.test.ts`) already proves the server-side
orchestration; STEP 2 is specifically to verify Valor's **real wire shapes**.

## STEP 3 — Go to production
Only after STEP 2 is fully green:
1. Naldo: set **`VALOR_IS_DEMO=false`** in Vercel (Production) → this points at Valor prod.
2. **Merge PR #84** to master (Jason review / Naldo's go) → prod auto-deploys.
3. **Post-launch smoke test:** run one real low-value deposit (or a closely-watched
   real customer) and confirm booked → receipt → CRM move end-to-end. Check the card
   is vaulted in the Valor portal (for the later manual balance charge).

---

## CONFIRM checklist (verify on staging — these were built from the spec, not a live probe)
Valor's docs host bot-blocks automated fetches, so these were coded defensively
behind `CONFIRM:` comments. Verify each against real staging traffic:

- [ ] **GetClientToken** endpoint path — built as `POST {base}/clienttoken`.
- [ ] **Request field names** — `app_id`, `app_key`, `epi`, `amount`, `order_id`, `save_card`.
- [ ] **Amount units** — built as a **dollars** string (`1350.00`). ⚠️ If Valor expects
      **cents**, fix `formatAmount()` — a wrong unit charges 100× or 1/100×.
- [ ] **Token response key** — parsed defensively (`clientToken`/`client_token`/`token`).
- [ ] **Save-to-vault flag** — built as `save_card: true`. Confirm the card actually vaults.
- [ ] **`order_id` echoes back in the webhook** — this is how the webhook finds the quote
      (`valor_order_ref`). If Valor does NOT echo it, the webhook 400s ("no-order-ref")
      and we need another mapping (e.g., store `txn_id` from the Passage.js `onSuccess`).
- [ ] **Webhook headers** — `Valor-Signature` + `Valor-Timestamp`.
- [ ] **Signing base + encoding** — verifier accepts `"{ts}.{body}"` and `"{body}"`, hex or
      base64. Pin to Valor's actual scheme once known.
- [ ] **Webhook payload field names** — `txn_id`, `response_code` ("00"=approved), `amount`,
      `approval_code`, `receipt_url`, vault token, order ref (all parsed with aliases).
- [ ] **Passage.js init API** — `mountPassage()` tries `init`/`render`/`mount`/constructor;
      confirm the real one and the `data-clientToken` attribute / onSuccess+onError shape.

## Rollback
If anything goes wrong after STEP 3:
- **Fastest:** set `VALOR_IS_DEMO=true` in Vercel + redeploy → back to staging (no real charges).
- **Full:** revert the PR #84 merge commit on master → restores the prior approve flow
  (the pre-Valor "we'll reach out for your deposit" placeholder is in git history, but the
  current approve route opens the checkout; a revert returns to whatever master had before).
- The customer's **approval snapshot is always saved first**, so no approval is ever lost
  even if payment/messaging fails.

## Key facts
- Deposit = **50%** (from the frozen approval snapshot, server-side — never the browser).
- Balance = charged **manually** by staff in the Valor portal after install (card auto-vaulted). No auto-charge is built.
- Staging base: `https://securelink-staging.valorpaytech.com:4430`. Prod base via `VALOR_IS_DEMO=false`.
- Webhook is the **single source of truth** for "booked" — Approve alone never books or charges.
