// src/app/api/integrations/whatsapp/webhook/route.ts
// Meta WhatsApp Cloud API webhook for the inventory bot (#82 Phase 3).
//   GET  — Meta's subscription verification handshake (echo hub.challenge).
//   POST — inbound message events: verify signature → enabled + allowlist →
//          run the command → reply.
// DORMANT by default — does nothing unless WHATSAPP_BOT_ENABLED='true' AND the
// Cloud-API config is set. Always 200s Meta on POST (so it doesn't disable the
// webhook) except on a bad signature. Public path (Meta calls it, no operator
// auth) — see src/lib/auth/operatorGate.ts.

import { NextRequest, NextResponse } from 'next/server';
import {
  isWhatsAppBotEnabled,
  isWhatsAppConfigured,
  whatsAppVerifyToken,
  isAllowedSender,
  verifyMetaSignature,
  sendWhatsAppText,
  handleWhatsAppText,
} from '@/lib/integrations/whatsapp';

export const runtime = 'nodejs';

// GET — webhook verification. Works whenever WHATSAPP_VERIFY_TOKEN is set, so the
// webhook can be verified in the Meta dashboard BEFORE the bot is switched on.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = whatsAppVerifyToken();
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const ack = () => NextResponse.json({ ok: true }); // keep Meta happy

  if (!isWhatsAppBotEnabled() || !isWhatsAppConfigured()) return ack();
  if (!verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), process.env.WHATSAPP_APP_SECRET)) {
    return new NextResponse('Bad signature', { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return ack();
  }

  // Meta's nested shape: entry[].changes[].value.messages[]. Take the first text.
  const msg = (body as { entry?: { changes?: { value?: { messages?: { from?: string; type?: string; text?: { body?: string } }[] } }[] }[] })
    ?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const text = msg?.text?.body;
  if (!msg || msg.type !== 'text' || !from || !text) return ack(); // ignore statuses / non-text

  if (!isAllowedSender(from)) {
    console.warn('[whatsapp] ignored command from a non-allowlisted number');
    return ack(); // silent — don't reveal the bot to unknown senders
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
  return ack();
}
