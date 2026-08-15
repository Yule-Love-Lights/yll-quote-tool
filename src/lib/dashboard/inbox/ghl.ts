// Pure GHL adapter: raw /conversations/search row → NormalizedTouch. No I/O.
// Field names + the two findings it encodes come from the live spike
// (scripts/spikes/ghl-conversations.ts, 2026-06-28): lastMessageDate is epoch-ms,
// channel comes from lastMessageType (not the overloaded `type`), and calls carry
// no body so their preview is synthesized.

import type { HighLevelConversation } from '@/lib/integrations/types';
import type { Channel, Direction, NormalizedTouch } from './types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';
import { classifyMessage } from './classify';

/** The raw GHL conversation shape this adapter consumes (from /conversations/search). */
export type GhlConversation = HighLevelConversation;

const CHANNEL_BY_TYPE: Record<string, Channel> = {
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
  TYPE_CALL: 'call',
  // #252: a live 4-call sweep against a test contact (2026-08-12) found GHL
  // reports an INBOUND call — answered, or answered-with-voicemail-left — as
  // TYPE_IVR_CALL, not TYPE_CALL (outbound calls stay TYPE_CALL). Without this
  // every inbound call fell through to channel: null and was invisible in the
  // inbox (no "📞 Inbound call" preview, see previewOf below).
  TYPE_IVR_CALL: 'call',
  // Aspirational: the 2026-06-28 spike guessed voicemails carry this type, but
  // the #252 live sweep never observed it — a voicemail is actually a
  // completed TYPE_IVR_CALL plus a separate GHL notification EMAIL ("X just
  // left a voicemail"). Left mapped in case GHL emits it from another path.
  TYPE_VOICEMAIL: 'call',
  TYPE_FACEBOOK: 'fb',
  TYPE_INSTAGRAM: 'ig',
  // TYPE_CAMPAIGN_EMAIL, TYPE_NO_SHOW: also seen in the #252 live sweep, still
  // unmapped on purpose — deliberately NOT guessed here, see ledger #252.
  // TYPE_NO_SHOW isn't a communication channel at all (GHL logging a missed
  // appointment, not a customer message), so channel stays null on purpose;
  // it gets a synthesized preview (previewOf below) and is forced 'automated'
  // (see isNoShow below) instead.
};

// #252: GHL logs a missed booked appointment as TYPE_NO_SHOW. It is not a
// customer touch — it must never sit in Open leads as unanswered or escalate
// (the RED-alert path) as though a customer wrote in. Unlike the removed
// ingest-time exclusion this bug started as, the row is still created and
// stays findable; only its lead_kind changes. Checked directly off the raw
// GHL type (channel is null for it — see CHANNEL_BY_TYPE above), the same
// shape as isActivityNoise below.
function isNoShow(lastMessageType: string | undefined): boolean {
  return lastMessageType === 'TYPE_NO_SHOW';
}

// #252: pure GHL system/CRM activity, not a customer touch (e.g. "Opportunity
// created", "DnD enabled by user"). This is NOT an ingest-time exclusion —
// that was the original #252 bug. searchConversations (highlevel.ts) returns
// only the SINGLE most-recent event per conversation, no message history, so
// unconditionally returning null here whenever that latest event happens to
// be activity noise could swallow a brand-new lead's FIRST-EVER touch forever
// (a GHL automation logging "Opportunity created" seconds after the customer's
// real message becomes the only thing the poller ever sees). A conversation
// with no existing inbox row must always be observable, whatever its latest
// event type is. So this only sets a flag; store.ts's planIngest is the one
// place that knows whether a row already exists, and decides there — skip the
// write when a row exists (never let noise bump/reopen a real conversation),
// ingest normally when it does not.
const ACTIVITY_NOISE_TYPES = new Set(['TYPE_ACTIVITY_CONTACT', 'TYPE_ACTIVITY_OPPORTUNITY']);

function channelOf(lastMessageType: string | undefined): Channel | null {
  if (!lastMessageType) return null;
  return CHANNEL_BY_TYPE[lastMessageType] ?? null;
}

function directionOf(raw: string | undefined): Direction | null {
  return raw === 'inbound' || raw === 'outbound' ? raw : null;
}

function previewOf(c: GhlConversation, channel: Channel | null, direction: Direction | null): string | null {
  const body = c.lastMessageBody?.trim();
  if (body) return body;
  // #252: a no-show carries no body either (same as a call); synthesize text
  // that reads as what it is (a missed appointment), never as a customer
  // message, so the row doesn't render blank when staff go looking for it.
  if (isNoShow(c.lastMessageType)) return '🚫 No-show (missed appointment)';
  if (channel === 'call') {
    const dir = direction === 'outbound' ? 'Outbound' : 'Inbound';
    return `📞 ${dir} call`;
  }
  return null;
}

export function normalizeGhlConversation(c: GhlConversation, suppressed?: Set<string>): NormalizedTouch {
  const isActivityNoise = !!c.lastMessageType && ACTIVITY_NOISE_TYPES.has(c.lastMessageType);
  const channel = channelOf(c.lastMessageType);
  const direction = directionOf(c.lastMessageDirection);
  const email = c.email ? normalizeEmail(c.email) : null;
  const phone = c.phone ? normalizePhone(c.phone) : null;
  const preview = previewOf(c, channel, direction);
  const isSuppressed =
    suppressed != null &&
    ((email != null && suppressed.has(email)) || (phone != null && suppressed.has(phone)));
  return {
    source: 'ghl',
    externalId: c.id,
    sourceMessageId: null, // search has no last-message id; the messages/webhook path sets it
    direction,
    channel,
    lastMessageAt: toDate(c.lastMessageDate ?? 0),
    preview,
    subject: null,
    identity: {
      ghlContactId: c.contactId ?? null,
      emails: email ? [email] : [],
      phones: phone ? [phone] : [],
      displayName: normalizeName(c.fullName ?? c.contactName ?? ''),
    },
    raw: c,
    // #252: a no-show is forced 'automated' the same way an isSuppressed
    // sender is — a short-circuit BEFORE the generic classifyMessage, because
    // it's a GHL-specific raw-type signal, not an email/preview-text pattern
    // classifyMessage already knows how to read.
    leadKind: isSuppressed || isNoShow(c.lastMessageType) ? 'automated' : classifyMessage({ fromAddress: null, subject: null, preview }),
    isActivityNoise,
  };
}
