// Pure GHL adapter: raw /conversations/search row → NormalizedTouch. No I/O.
// Field names + the two findings it encodes come from the live spike
// (scripts/spikes/ghl-conversations.ts, 2026-06-28): lastMessageDate is epoch-ms,
// channel comes from lastMessageType (not the overloaded `type`), and calls carry
// no body so their preview is synthesized.

import type { Channel, Direction, NormalizedTouch } from './types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';

/** The subset of a GHL conversation (from /conversations/search) we read. */
export type GhlConversation = {
  id: string;
  locationId?: string;
  lastMessageDate: number | string;
  lastMessageType?: string; // TYPE_SMS | TYPE_EMAIL | TYPE_CALL | TYPE_FACEBOOK | ...
  lastMessageBody?: string;
  lastMessageDirection?: string; // 'inbound' | 'outbound'
  unreadCount?: number;
  contactId?: string;
  fullName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  type?: string; // contact channel class (e.g. TYPE_PHONE) — NOT the message channel
};

const CHANNEL_BY_TYPE: Record<string, Channel> = {
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
  TYPE_CALL: 'call',
  TYPE_VOICEMAIL: 'call',
  TYPE_FACEBOOK: 'fb',
  TYPE_INSTAGRAM: 'ig',
};

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
  if (channel === 'call') {
    const dir = direction === 'outbound' ? 'Outbound' : 'Inbound';
    return `📞 ${dir} call`;
  }
  return null;
}

export function normalizeGhlConversation(c: GhlConversation): NormalizedTouch {
  const channel = channelOf(c.lastMessageType);
  const direction = directionOf(c.lastMessageDirection);
  const email = c.email ? normalizeEmail(c.email) : null;
  const phone = c.phone ? normalizePhone(c.phone) : null;
  return {
    source: 'ghl',
    externalId: c.id,
    sourceMessageId: null, // search has no last-message id; the messages/webhook path sets it
    direction,
    channel,
    lastMessageAt: toDate(c.lastMessageDate),
    preview: previewOf(c, channel, direction),
    subject: null,
    identity: {
      ghlContactId: c.contactId ?? null,
      emails: email ? [email] : [],
      phones: phone ? [phone] : [],
      displayName: normalizeName(c.fullName ?? c.contactName ?? ''),
    },
    raw: c,
  };
}
