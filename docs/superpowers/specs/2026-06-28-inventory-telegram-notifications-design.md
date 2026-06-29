# Proactive Telegram notifications for the inventory bot (#82 follow-up)

**Date:** 2026-06-28
**Owner:** Naldo (inventory lane)
**Status:** design — pending build
**Branch:** `naldo/inventory-telegram-notify` (off master `a25cb5d`)

## Problem

The inventory Telegram bot (`@YLLInventoryBot`, shipped #224, live on prod) is **pull-only**: it answers commands (`help`, `jobs`, `low`, `prep`, `move`, `stock`, `set`) but never messages the group on its own. The proactive nudges that *do* exist (low-stock digest, supplier PO) go out by **email**. Naldo wants the bot to also **push a message to the inventory group** when key events happen, so staff don't have to remember to ask.

## Goal

Post a Telegram message to the inventory group — **in addition to** the existing email — on three events:

1. **Job needs prepping** — a deposit was paid and a job was created. Include the **full projected materials list** for that job with a per-line stock flag.
2. **Low stock** — a SKU **newly** drops to/below its reorder point (not a daily re-nag). List the newly-low items.
3. **PO sent to supplier** — a purchase order email went out (manual click, auto-send cron, or the ≥5-jobs event trigger). List what was ordered.

All three are **best-effort / fail-open** and **dormancy-aware**: a Telegram failure must never break job creation, the customer receipt, the cron, or the supplier email; and pings only fire when the bot is enabled + configured (`TELEGRAM_BOT_ENABLED='true'` + `TELEGRAM_BOT_TOKEN` set) — the same gate as the command bot.

## Decisions (locked with Naldo)

- **Notify target:** reuse `TELEGRAM_ALLOWED_CHATS` — broadcast each ping to every chat the bot already serves (today: the one inventory group `-5462733377`). **No new env var.**
- **All three events list their items** (prep shows full materials w/ stock flags; low-stock lists newly-low SKUs; PO lists ordered SKUs).
- **Low-stock cadence:** only when something **newly** goes low (dedup state remembers what was already reported; resets when stock recovers).
- **Per-line stock flags** on the prep list: ✅ in stock / ⚠️ short (with on-hand count) / ➖ not tracked.
- **Telegram is additive**, not a replacement for the existing emails.

## Architecture

Two small new pure-core modules + one thin IO notifier, then three one-line hooks into existing code. Matches the codebase's "pure projection + thin IO" pattern.

### New: `src/lib/integrations/telegramMessages.ts` (PURE — fully unit-testable)

Pure formatters, no IO, no `process.env`. `baseUrl` is passed in by the caller.

- `prepJobMessage(args: { customerName: string | null; jobNumber: number | null; materials: MaterialRow[]; unbound: UnboundConcept[]; baseUrl: string }): string`
  - Header: `🔔 New job to prep — {customerName ?? 'Customer'}{ jobNumber ? ` (Job #${jobNumber})` : '' }`
  - One bullet per material: `• {name} ({sku}) ×{qty} — {flag}` where flag is
    `➖ not tracked` (onHand === null) · `⚠️ short ({onHand} on hand)` (short) · `✅ in stock` (else).
  - Unbound concepts (need but no SKU bound) listed as `• {label} ×{qty} — ⚠️ no SKU bound`.
  - Empty (no materials, no unbound) → `No tracked materials projected.`
  - Footer: `Prep → {baseUrl}/inventory/jobs`
- `lowStockMessage(args: { items: { name: string; sku: string; onHand: number; reorderPoint: number }[]; baseUrl: string }): string`
  - Header: `⚠️ Low stock — {n} new item(s) need ordering`
  - Bullet: `• {name} ({sku}): {onHand} on hand (reorder {reorderPoint})`
  - Footer: `Order → {baseUrl}/inventory/orders`
- `poSentMessage(args: { lines: { name: string; sku: string; order: number }[]; jobCount: number; baseUrl: string }): string`
  - Header: `📦 Purchase order sent to supplier — {jobCount} job(s)`
  - Bullet: `• {name} ({sku}) ×{order}`
  - Footer: `Details → {baseUrl}/inventory/orders`
- `capList(bullets: string[], max = 40): string[]` — shared helper: if `bullets.length > max`, keep the first `max` and append `…+{extra} more`. Guards against Telegram's 4000-char truncation cutting mid-line. (`sendTelegramMessage` already hard-slices at 4000 as a final backstop.)

### New: `src/lib/integrations/telegramNotify.ts` (thin IO)

- `appBaseUrl(): string` → `process.env.PORTAL_BASE_URL || 'https://quote.yulelovelights.com'` (same env var the Valor webhook uses for absolute links).
- `notifyTelegram(text: string): Promise<void>` — **best-effort broadcast**:
  - No-op (return) unless `isTelegramBotEnabled() && isTelegramConfigured()` and `allowedChats().length`.
  - `for (const chat of allowedChats())` → `await sendTelegramMessage(chat, text)` each wrapped in try/catch; log + continue on error. **Never throws.**

### Edit: `src/lib/integrations/telegram.ts`

- Add exported `allowedChats(): string[]` (parse `TELEGRAM_ALLOWED_CHATS` once) and refactor `isAllowedChat` to use it — one source of truth for the parse. No behavior change.

### New: `src/lib/inventory/lowStockNotify.ts`

- `newlyLowSkus(currentLow: string[], lastNotified: string[]): string[]` — **pure** set difference (current − last).
- `getLastLowStockNotified(): Promise<string[]>` / `recordLowStockNotified(skus: string[]): Promise<void>` — `app_settings` kv IO, key `low_stock_notify_last`, value `{ skus, at }` (mirrors `getLastAutoSentSignature`/`recordAutoSentSignature`). No migration (existing kv table, new key).

## Trigger wiring (additive, best-effort)

### 1. Prep — `src/app/api/integrations/valor/webhook/route.ts`

In the **won-the-claim** block (fires at most once per payment — the existing atomic claim already dedups Valor's retries), where `createJobFromQuote(quote.id)` is called:

```ts
let job: JobRow | null = null;
try { job = await createJobFromQuote(quote.id); }
catch (err) { console.error('[valor/webhook] job auto-create failed:', err); }

// NEW — best-effort prep ping (never blocks the webhook).
try {
  if (job) {
    const wo = await getJobWorkOrder(job.id);
    if (wo) {
      await notifyTelegram(prepJobMessage({
        customerName: wo.job.customerName,
        jobNumber: wo.job.jobNumber,
        materials: wo.materials.materials,
        unbound: wo.materials.unbound,
        baseUrl: (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, ''),
      }));
    }
  }
} catch (err) { console.error('[valor/webhook] prep ping failed:', err); }
```

Once-per-job guaranteed by the existing claim — no extra dedup needed.

### 2. PO sent — `src/lib/inventory/purchaseOrder.ts` (`emailSupplierPurchaseOrder`)

After the supplier email succeeds, before `return { ok: true }`:

```ts
try {
  await notifyTelegram(poSentMessage({
    lines: po.lines.map((l) => ({ name: l.name, sku: l.sku, order: l.order })),
    jobCount: po.jobCount,
    baseUrl: appBaseUrl(),
  }));
} catch (err) { console.error('PO sent ping failed:', err); }
```

One hook covers **all three** PO paths (manual `/inventory/orders`, the auto-send cron, the ≥5-jobs event trigger) because they all funnel through `emailSupplierPurchaseOrder`. The auto-send dedup (signature) already prevents re-sending an unchanged order, so no duplicate pings.

### 3. Low stock — `src/app/api/inventory/low-stock-alert/route.ts`

After `low` is computed (and alongside the existing email), gated on the bot being live so the dedup baseline isn't silently consumed while the bot is off:

```ts
if (low.length && isTelegramBotEnabled() && isTelegramConfigured()) {
  const currentLow = low.map((l) => l.sku);
  const newly = newlyLowSkus(currentLow, await getLastLowStockNotified());
  if (newly.length) {
    const newlySet = new Set(newly);
    await notifyTelegram(lowStockMessage({
      items: low.filter((l) => newlySet.has(l.sku)).map((l) => ({
        name: nameBySku.get(l.sku) ?? '(not in catalog)', sku: l.sku,
        onHand: l.onHand, reorderPoint: l.reorderPoint,
      })),
      baseUrl: appBaseUrl(),
    }));
  }
  await recordLowStockNotified(currentLow); // recovered SKUs drop out → can re-ping later
}
```

Runs daily (the cron cadence) but **pings only on newly-low SKUs**. Enabling the bot gives one catch-up ping of what's currently low, then steady-state new-only.

## Data / migration

**None.** Low-stock dedup state is a new key in the existing `app_settings` kv table (same as the PO signature and the portal toggle).

## Testing (TDD)

- `telegramMessages.test.ts` (pure): each formatter — stock-flag branches, empty-materials case, unbound rows, `capList` "+N more", link footers.
- `telegramNotify.test.ts`: no-op when disabled / unconfigured / empty allowlist; broadcasts to every chat; swallows a `sendTelegramMessage` rejection (never throws).
- `lowStockNotify.test.ts` (pure): `newlyLowSkus` — new item pings, unchanged returns none, recovered-then-relow pings again.
- Extend `valor/webhook/route.test.ts`: a new booking fires the prep ping once (mock `notifyTelegram`); a lost-claim retry does not.
- PO + low-stock route tests: notify fires on success / newly-low; not on unchanged / nothing-low.

**Gates:** `npx tsc --noEmit` · targeted `eslint` on changed files · `vitest` on the new + touched suites (the 8 GB box OOMs on the full run — Vercel's build is the authoritative full gate, per the #82 working pattern).

## Scope / ownership

New: `telegramMessages.ts`, `telegramNotify.ts`, `lowStockNotify.ts` (+ tests). Edits: `telegram.ts` (export `allowedChats`), `purchaseOrder.ts`, `low-stock-alert/route.ts`, `valor/webhook/route.ts`. All in the inventory lane except the **Valor payment webhook** — the change there is purely additive + fail-open, and the inventory epic already edits that file (`triggerAutoPOIfBusy`); flag for Jason's awareness since it's the shared payment flow.

## Out of scope (YAGNI)

- A dedicated `TELEGRAM_NOTIFY_CHAT` env var (reusing the allowlist is enough for one group).
- Per-event on/off toggles, quiet hours, message templating UI.
- Replacing the email channel.
- Inbound interactivity from the pings (buttons/callbacks).
