// Pure Gmail logic — "needs reply?" detection + thread → NormalizedTouch.
// Operates on an already-extracted message list (the live googleapis client is
// deferred until the Gmail OAuth + dependency are in place). The future adapter
// maps Gmail's raw payload into GmailMessageLite/GmailThreadLite and this decides
// direction the same way GHL does, so the reducer treats both sources uniformly.
//
// Detection (per plan): a thread needs a reply when its last message is NOT from
// us — equivalently, no SENT message after the last inbound (timestamp-based via
// the shared isAnsweredByOutbound).

import type { NormalizedTouch } from './types';
import { normalizeEmail, normalizeName } from './normalize';
import { isAnsweredByOutbound } from './escalation';

export type GmailMessageLite = {
  /** Did the YLL workspace account send this message (a SENT message). */
  fromMe: boolean;
  at: Date;
  snippet?: string;
};

export type GmailThreadLite = {
  threadId: string;
  subject?: string;
  /** The external party on the thread. */
  from?: { email?: string; name?: string };
  /** All messages on the thread (any order). */
  messages: GmailMessageLite[];
};

function partition(messages: GmailMessageLite[]): {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  latest: GmailMessageLite | null;
} {
  let lastInboundAt: Date | null = null;
  let lastOutboundAt: Date | null = null;
  let latest: GmailMessageLite | null = null;
  for (const m of messages) {
    if (m.fromMe) {
      if (!lastOutboundAt || m.at > lastOutboundAt) lastOutboundAt = m.at;
    } else if (!lastInboundAt || m.at > lastInboundAt) {
      lastInboundAt = m.at;
    }
    if (!latest || m.at > latest.at) latest = m;
  }
  return { lastInboundAt, lastOutboundAt, latest };
}

/** True when the thread's last message is from the customer (awaiting our reply). */
export function gmailNeedsReply(messages: GmailMessageLite[]): boolean {
  const { lastInboundAt, lastOutboundAt } = partition(messages);
  if (!lastInboundAt) return false; // nothing inbound to answer
  return !isAnsweredByOutbound({ lastInboundAt, lastOutboundAt });
}

export function normalizeGmailThread(thread: GmailThreadLite): NormalizedTouch {
  const { lastInboundAt, lastOutboundAt, latest } = partition(thread.messages);
  const answered = isAnsweredByOutbound({ lastInboundAt, lastOutboundAt });
  const email = thread.from?.email ? normalizeEmail(thread.from.email) : null;
  return {
    source: 'gmail',
    externalId: thread.threadId,
    sourceMessageId: null,
    direction: answered ? 'outbound' : 'inbound',
    channel: 'email',
    lastMessageAt: latest ? latest.at : new Date(0),
    preview: latest?.snippet ?? null,
    subject: thread.subject ?? null,
    identity: {
      ghlContactId: null,
      emails: email ? [email] : [],
      phones: [],
      displayName: thread.from?.name ? normalizeName(thread.from.name) : null,
    },
    raw: thread,
  };
}
