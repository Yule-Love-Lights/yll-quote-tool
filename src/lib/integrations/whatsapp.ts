// src/lib/integrations/whatsapp.ts
// Inventory WhatsApp bot — Meta WhatsApp Cloud API client + command dispatcher
// (#82 Phase 3). DORMANT by default: nothing runs unless WHATSAPP_BOT_ENABLED=
// 'true' AND the config env vars are set. Staff text the business number to move
// job cards + update stock; the webhook (src/app/api/integrations/whatsapp/
// webhook/route.ts) verifies Meta's signature, checks the sender allowlist, then
// runs the parsed command here.
//
// Env (see docs/superpowers/specs/2026-06-28-inventory-82-phase3-whatsapp.md):
//   WHATSAPP_BOT_ENABLED, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
//   WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ALLOWED_NUMBERS

import crypto from 'node:crypto';
import { safeEqual } from '@/lib/security';
import {
  listFulfillmentCards,
  setJobFulfillmentStage,
  prepareJobMaterials,
} from '@/lib/inventory/jobs';
import { listOnHand, upsertOnHand, toQty } from '@/lib/inventory/onHand';
import { FULFILLMENT_STAGE_LABELS } from '@/lib/inventory/fulfillmentStage';
import { parseWhatsAppCommand, WHATSAPP_HELP, type WhatsAppCommand } from './whatsappCommands';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const MAX_LIST = 30; // cap rows in a reply so a message never balloons

export function isWhatsAppBotEnabled(): boolean {
  return process.env.WHATSAPP_BOT_ENABLED === 'true';
}
export function isWhatsAppConfigured(): boolean {
  return !!(
    process.env.WHATSAPP_APP_SECRET &&
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}
export function whatsAppVerifyToken(): string | undefined {
  return process.env.WHATSAPP_VERIFY_TOKEN;
}

/** Only known staff numbers may command the bot. Fails closed (empty ⇒ none). */
export function isAllowedSender(from: string | undefined): boolean {
  const allow = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
  if (!allow.length) return false;
  const norm = (from ?? '').replace(/\D/g, '');
  return !!norm && allow.includes(norm);
}

/** Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 of the RAW body w/ the app secret). */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(signatureHeader, expected);
}

/** Send a plain-text WhatsApp message via the Cloud API. Throws on failure. */
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WhatsApp not configured');
  const res = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: body.slice(0, 4000) },
    }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

/** Run a parsed command against the live board + stock → the reply text. */
export async function runWhatsAppCommand(cmd: WhatsAppCommand): Promise<string> {
  switch (cmd.kind) {
    case 'help':
      return WHATSAPP_HELP;

    case 'jobs': {
      const cards = await listFulfillmentCards();
      if (!cards.length) return 'No active jobs.';
      return cards
        .slice(0, MAX_LIST)
        .map((c) => `#${c.jobNumber ?? '—'} ${c.customerName ?? ''} — ${FULFILLMENT_STAGE_LABELS[c.stage]}`.trim())
        .join('\n');
    }

    case 'move': {
      const card = (await listFulfillmentCards()).find((c) => c.jobNumber === cmd.jobNumber);
      if (!card) return `No active job #${cmd.jobNumber}.`;
      const ok = await setJobFulfillmentStage(card.id, cmd.stage);
      return ok
        ? `Job #${cmd.jobNumber} → ${FULFILLMENT_STAGE_LABELS[cmd.stage]}.`
        : `Couldn't move job #${cmd.jobNumber}.`;
    }

    case 'prep': {
      const card = (await listFulfillmentCards()).find((c) => c.jobNumber === cmd.jobNumber);
      if (!card) return `No active job #${cmd.jobNumber}.`;
      const r = await prepareJobMaterials(card.id);
      if (!r) return `Couldn't prep job #${cmd.jobNumber}.`;
      if (r.alreadyDone) return `Job #${cmd.jobNumber} was already prepped — stock not deducted again.`;
      const n = r.deductions.length;
      return `Job #${cmd.jobNumber} prepped — deducted ${n} SKU${n === 1 ? '' : 's'} from stock. Now Ready For Install.`;
    }

    case 'stock': {
      const row = (await listOnHand()).find((r) => r.sku === cmd.sku);
      return row
        ? `${cmd.sku}: ${row.on_hand_qty} on hand (reorder at ${row.reorder_point}).`
        : `${cmd.sku} isn't tracked in on-hand stock.`;
    }

    case 'set': {
      const qty = toQty(cmd.qty);
      await upsertOnHand({ sku: cmd.sku, on_hand_qty: qty });
      return `${cmd.sku} on-hand set to ${qty}.`;
    }

    case 'low': {
      const low = (await listOnHand()).filter((r) => r.reorder_point > 0 && r.on_hand_qty <= r.reorder_point);
      if (!low.length) return 'No low-stock items. 👍';
      return 'Low stock:\n' + low.slice(0, MAX_LIST).map((r) => `${r.sku}: ${r.on_hand_qty} ≤ ${r.reorder_point}`).join('\n');
    }

    default:
      return 'Didn\'t understand that. Text "help" for commands.';
  }
}

/** Convenience for the webhook: parse + run in one call. */
export async function handleWhatsAppText(text: string): Promise<string> {
  return runWhatsAppCommand(parseWhatsAppCommand(text));
}
