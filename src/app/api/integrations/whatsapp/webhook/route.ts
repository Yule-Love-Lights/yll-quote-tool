// src/app/api/integrations/whatsapp/webhook/route.ts
// Twilio WhatsApp webhook for the inventory bot (#82 Phase 3).
//   POST — inbound message event from Twilio (form-encoded body): verify the
//          X-Twilio-Signature → check enabled+allowlist → run the command → reply.
// Unlike Meta, Twilio has NO subscription handshake — they just POST the URL you
// configured in the Twilio Console under your WhatsApp Sender. (A GET handler is
// kept that simply 200s so the URL is browsable / monitorable.)
//
// DORMANT by default — does nothing unless WHATSAPP_BOT_ENABLED='true' AND the
// Twilio config is set. Always returns 200 (TwiML empty body) except on a bad
// signature (401) so Twilio doesn't retry endlessly. Public path (Twilio calls
// it, no operator auth) — see src/lib/auth/operatorGate.ts.

import { NextRequest, NextResponse } from 'next/server';
import {
  isWhatsAppBotEnabled,
  isWhatsAppConfigured,
  isAllowedSender,
  verifyTwilioSignature,
  sendWhatsAppText,
  handleWhatsAppText,
} from '@/lib/integrations/whatsapp';

export const runtime = 'nodejs';

// Twilio expects a TwiML response, but an empty 200 means "no reply via TwiML"
// (we send our reply via the Messages API instead — works regardless of how the
// outbound was triggered). Empty body keeps the wire small.
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const okTwiml = () =>
  new NextResponse(TWIML_EMPTY, { status: 200, headers: { 'Content-Type': 'text/xml' } });

export async function GET() {
  // Twilio doesn't need a verification handshake — a plain 200 keeps the URL
  // browsable for ops checks.
  return new NextResponse('OK', { status: 200 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!isWhatsAppBotEnabled() || !isWhatsAppConfigured()) return okTwiml();

  // Reconstruct the public URL Twilio actually POSTed to (Vercel runs behind
  // proxying, so prefer forwarded headers — req.url may show the internal one).
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;

  // Twilio always sends application/x-www-form-urlencoded — parse to a plain map.
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  if (!verifyTwilioSignature(url, params, req.headers.get('x-twilio-signature'), process.env.TWILIO_AUTH_TOKEN)) {
    return new NextResponse('Bad signature', { status: 401 });
  }

  // Twilio webhook fields: From (whatsapp:+xxx), Body (text), MessageSid, etc.
  // Status callbacks (sent/delivered/failed) carry MessageStatus instead of Body —
  // ignore those quietly.
  const from = params.From;
  const text = params.Body;
  if (!from || !text) return okTwiml();

  if (!isAllowedSender(from)) {
    console.warn('[whatsapp] ignored command from a non-allowlisted number');
    return okTwiml(); // silent — don't reveal the bot to unknown senders
  }

  try {
    const reply = await handleWhatsAppText(text);
    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error('[whatsapp] command handling failed:', err);
    try {
      await sendWhatsAppText(from, 'Something went wrong handling that.');
    } catch {
      /* best-effort */
    }
  }
  return okTwiml();
}
