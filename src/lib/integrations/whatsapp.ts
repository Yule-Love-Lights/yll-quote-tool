// src/lib/integrations/whatsapp.ts
// Inventory WhatsApp bot — Twilio WhatsApp API client + command dispatcher
// (#82 Phase 3, Naldo uses Twilio). DORMANT by default: nothing runs unless
// WHATSAPP_BOT_ENABLED='true' AND the Twilio config env vars are set. Staff text
// the Twilio WhatsApp number; the webhook (src/app/api/integrations/whatsapp/
// webhook/route.ts) verifies Twilio's signature, checks the sender allowlist,
// then runs the parsed command here.
//
// Env:
//   WHATSAPP_BOT_ENABLED     'true' to activate (master flag)
//   TWILIO_ACCOUNT_SID       AC...
//   TWILIO_AUTH_TOKEN        signs every webhook + Basic-auths the send API
//   TWILIO_WHATSAPP_FROM     sender number, format whatsapp:+15555551234
//   WHATSAPP_ALLOWED_NUMBERS comma-separated E.164 staff numbers (e.g. +16315170186)

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
import { interpretBotText, type BotInterpretation } from './botInterpreter';
import { runStatusTool, runScheduleTool } from './botTools';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const MAX_LIST = 30; // cap rows in a reply so a message never balloons

const NOT_UNDERSTOOD = 'Didn\'t understand that. Text "help" for commands.';

export function isWhatsAppBotEnabled(): boolean {
  return process.env.WHATSAPP_BOT_ENABLED === 'true';
}
export function isWhatsAppConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM
  );
}

/** Only known staff numbers may command the bot. Fails closed (empty ⇒ none). */
export function isAllowedSender(from: string | undefined): boolean {
  const allow = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
  if (!allow.length) return false;
  // Twilio sends From as "whatsapp:+15555551234" — strip the prefix and any non-digits.
  const norm = (from ?? '').replace(/\D/g, '');
  return !!norm && allow.includes(norm);
}

/**
 * Verify Twilio's X-Twilio-Signature header.
 * Twilio's scheme (v1):
 *   data   = full request URL + (for each POST param, sorted by key: key + value, concatenated)
 *   sig    = base64(HMAC-SHA1(authToken, data))
 *   header = X-Twilio-Signature
 * See https://www.twilio.com/docs/usage/webhooks/webhooks-security.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null | undefined,
  authToken: string | undefined,
): boolean {
  if (!authToken || !signatureHeader) return false;
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  return safeEqual(signatureHeader, expected);
}

/** Send a plain-text WhatsApp message via Twilio's Messages API. Throws on failure. */
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) throw new Error('Twilio WhatsApp not configured');
  // Recipient must carry the whatsapp: prefix; Twilio inbound webhooks always use it.
  const toAddr = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const form = new URLSearchParams({ From: from, To: toAddr, Body: body.slice(0, 1500) });
  const res = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`Twilio send failed: ${res.status} ${await res.text().catch(() => '')}`);
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
      return NOT_UNDERSTOOD;
  }
}

/**
 * Run one interpreted READ tool (Phase 1 of the 2026-07-19 text-ops plan).
 * This path calls interpretBotText WITHOUT allowWrites, so the interpretation
 * can only be one of the six read tools — but the shared type now also covers
 * the Phase-2 write tools (which are gated in botDispatch, not here), so an
 * unexpected tool falls through to the safe reply rather than executing.
 */
async function runInterpreted(interp: BotInterpretation, raw: string): Promise<string> {
  switch (interp.tool) {
    case 'status':
      // The model usually extracts the name/number; the raw text still works as
      // a substring search when it didn't.
      return runStatusTool(interp.args.query ?? raw);
    case 'schedule':
      return runScheduleTool(interp.args.when ?? 'today');
    case 'stock':
      return interp.args.sku
        ? runWhatsAppCommand({ kind: 'stock', sku: interp.args.sku })
        : NOT_UNDERSTOOD;
    case 'low':
      return runWhatsAppCommand({ kind: 'low' });
    case 'jobs':
      return runWhatsAppCommand({ kind: 'jobs' });
    case 'help':
      return runWhatsAppCommand({ kind: 'help' });
    default:
      return NOT_UNDERSTOOD;
  }
}

/**
 * Convenience for the webhooks: parse + run in one call. Keyword commands parse
 * deterministically and never touch the LLM; only unmatched text falls through
 * to the interpreter (Phase 1: read tools only), and any interpreter miss lands
 * on the same "didn't understand" reply the bot always had.
 */
export async function handleWhatsAppText(text: string): Promise<string> {
  const cmd = parseWhatsAppCommand(text);
  if (cmd.kind !== 'unknown') return runWhatsAppCommand(cmd);

  const interp = await interpretBotText(text);
  if (!interp) return NOT_UNDERSTOOD;
  return runInterpreted(interp, text);
}
