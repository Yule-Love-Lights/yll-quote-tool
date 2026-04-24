// Home.works integration via Zapier webhook. Home.works doesn't expose a
// direct public API that fits our "push a signed quote with line items"
// use case, so we route through Zapier as a thin adapter layer:
//
//   Quote tool ──POST JSON──> Zapier Catch Hook ──> home.works action
//
// Zap setup (one-time, on naldoven@yulelovelights.com's Zapier account):
//   1. Trigger: "Webhooks by Zapier — Catch Hook"
//   2. Copy the Catch Hook URL into HOMEWORKS_ZAPIER_WEBHOOK_URL
//   3. Action: home.works "Create Estimate" (or equivalent) — map fields
//      from the payload (see HomeworksPayload in ./types.ts)
//   4. Test with a fake payload from the admin UI before going live
//
// Why this architecture:
//   - Zero lock-in to home.works's specific schema — swap the Zap target
//     to ServiceTitan, Jobber, or Housecall Pro in 5 minutes without
//     touching our code.
//   - Zapier handles retries + error visibility (Naldo sees failures in
//     Zap History, doesn't need us to build monitoring).
//   - We avoid storing home.works credentials in our env — Zapier holds
//     them. Reduces our security surface.

import type { HomeworksPayload, HomeworksSendResult } from './types';

export class HomeworksError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'HomeworksError';
  }
}

export function isHomeworksConfigured(): boolean {
  return !!process.env.HOMEWORKS_ZAPIER_WEBHOOK_URL;
}

// ─── Build the single-line-item payload ───────────────────────────────────
// home.works (and some older invoicing systems) accept only ONE line item
// per estimate. To keep the full breakdown visible to the customer + crew,
// we collapse everything into:
//   name        = package name the customer picked
//   description = readable breakdown of every selected item + pricing math
//   quantity    = 1
//   totalUsd    = subtotal-after-discount PLUS takedown (pre-tax)
//
// Tax, deposit, and balance-due are deliberately NOT sent — home.works
// computes tax on its side (state/local rates live there, not here), and
// deposit + balance flow from that post-tax total. If we sent our own
// deposit/balance numbers they'd be wrong once home.works added tax.
//
// Takedown is rendered as the LAST bullet in the items list (alongside
// "Santa's Roofline" etc.) so the customer sees it itemized rather than
// appearing as a surprise charge after subtotal. Its dollar amount is
// also folded into subtotal + line-item total so the numbers add up.
export type HomeworksSingleLineItemInput = {
  packageName: string;
  lineItems: ReadonlyArray<{ label: string; amountUsd: number }>;
  subtotalBeforeDiscountUsd: number;
  discountAmountUsd: number;
  subtotalAfterDiscountUsd: number;
  rushFeeUsd: number;
  takedownUsd: number;
  minimumApplied: boolean;
};

function formatUsdLocal(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function buildHomeworksSingleLineItem(
  input: HomeworksSingleLineItemInput,
): {
  name: string;
  description: string;
  quantity: 1;
  totalUsd: number;
} {
  const parts: string[] = [];

  parts.push(`Package: ${input.packageName}`);
  parts.push('');

  // Items list — regular line items first, then rush fee (if applied),
  // then takedown as the final bullet. Both surcharges are rendered as
  // items rather than as post-subtotal adjustments so the customer sees
  // the full list of what they're paying for in one block.
  parts.push('Selected items:');
  for (const li of input.lineItems) {
    parts.push(`  • ${li.label} — ${formatUsdLocal(li.amountUsd)}`);
  }
  if (input.rushFeeUsd > 0) {
    parts.push(`  • Rush fee — ${formatUsdLocal(input.rushFeeUsd)}`);
  }
  if (input.takedownUsd > 0) {
    parts.push(`  • Takedown — ${formatUsdLocal(input.takedownUsd)}`);
  }
  parts.push('');

  // Subtotals fold both rush fee + takedown in so the description math
  // matches the line-item total that home.works will display.
  const extrasUsd = input.rushFeeUsd + input.takedownUsd;
  const subtotalWithExtrasUsd = input.subtotalBeforeDiscountUsd + extrasUsd;
  const subtotalAfterDiscountWithExtrasUsd =
    input.subtotalAfterDiscountUsd + extrasUsd;

  parts.push('Pricing breakdown:');
  parts.push(`  Subtotal: ${formatUsdLocal(subtotalWithExtrasUsd)}`);
  if (input.discountAmountUsd > 0) {
    parts.push(`  Discount: -${formatUsdLocal(input.discountAmountUsd)}`);
  }
  parts.push(
    `  Subtotal after discount: ${formatUsdLocal(subtotalAfterDiscountWithExtrasUsd)}`,
  );
  // Tax / Grand total / Deposit / Balance deliberately omitted —
  // home.works calculates tax and derives deposit + balance from it.

  if (input.minimumApplied) {
    parts.push('');
    parts.push('Note: Season minimum applied.');
  }

  return {
    name: input.packageName,
    description: parts.join('\n'),
    quantity: 1,
    totalUsd: subtotalAfterDiscountWithExtrasUsd,
  };
}

// ─── Send quote to home.works ─────────────────────────────────────────────
// Fires the Zapier webhook with the full quote payload. Returns whether
// Zapier accepted the request (not whether home.works ultimately created
// the estimate — that's async on Zapier's side).
//
// Retry behavior: Zapier catch hooks are already retried by Zapier itself
// (up to 3× on non-2xx from the downstream action). We retry HERE only
// on transient network errors (timeout, ECONNRESET). Application-level
// errors from the Zap should surface in Zapier's dashboard, not ours.
export async function sendQuoteToHomeworks(payload: HomeworksPayload): Promise<HomeworksSendResult> {
  const url = process.env.HOMEWORKS_ZAPIER_WEBHOOK_URL;
  if (!url) {
    throw new HomeworksError(
      'Home.works not configured. Set HOMEWORKS_ZAPIER_WEBHOOK_URL in .env.local (get the URL from your Zapier Catch Hook trigger).',
    );
  }

  // Validate the URL — guards against someone pasting the wrong thing
  // into the env var (e.g., the Zap editor URL instead of the hook URL).
  // Zapier catch hooks are always at hooks.zapier.com/hooks/catch/....
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'hooks.zapier.com') {
      throw new HomeworksError(
        `HOMEWORKS_ZAPIER_WEBHOOK_URL should be a hooks.zapier.com URL (got ${parsed.hostname}). Did you copy the right value from the Zap "Catch Hook" step?`,
      );
    }
  } catch (err) {
    if (err instanceof HomeworksError) throw err;
    throw new HomeworksError(`HOMEWORKS_ZAPIER_WEBHOOK_URL is not a valid URL: ${url}`);
  }

  const t0 = Date.now();
  let lastErr: unknown;

  // Network-level retry. 2 attempts — Zapier itself is highly reliable,
  // we're guarding against Vercel→Zapier transient hiccups only.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // 15s cap — Zapier's catch hook responds in <1s normally. Longer
        // means something's wrong, and we'd rather surface the error to
        // the operator than hang the admin UI.
        signal: AbortSignal.timeout(15_000),
      });

      const text = await res.text().catch(() => '');
      let webhookResponse: unknown = text;
      try { webhookResponse = JSON.parse(text); } catch { /* keep as text */ }

      if (!res.ok) {
        // Non-2xx from Zapier itself is unusual — either the hook URL is
        // wrong or Zapier is down. Return the error so the operator can
        // see it in the admin UI.
        return {
          ok: false,
          statusCode: res.status,
          webhookResponse,
          error: `Zapier webhook returned ${res.status}. Check the Zap is turned on and the hook URL is correct.`,
        };
      }

      const elapsedMs = Date.now() - t0;
      console.log(`[homeworks] sent quote ${payload.quoteId} to Zapier in ${elapsedMs}ms`);
      return { ok: true, statusCode: res.status, webhookResponse };
    } catch (err) {
      lastErr = err;
      // Timeout / network — retryable.
      continue;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new HomeworksError(`Failed to reach Zapier after 2 attempts: ${msg}`);
}
