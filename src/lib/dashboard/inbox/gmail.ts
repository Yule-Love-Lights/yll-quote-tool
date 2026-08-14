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
import { classifyMessage, isFromUs } from './classify';
import { parseLeadForward } from './leadForward';

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
  /** True when any raw message carried a List-Unsubscribe header (bulk/marketing). */
  hasListUnsubscribe: boolean;
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

// ─── Raw Gmail payload → GmailThreadLite (pure mapping) ─────────────────────
// Minimal subset of the Gmail REST shapes the client returns. The mapper turns
// them into the source-agnostic GmailThreadLite that normalizeGmailThread + the
// reducer consume.

export type GmailHeader = { name: string; value: string };
export type RawGmailMessage = {
  id: string;
  labelIds?: string[];
  internalDate?: string; // epoch ms as a string
  snippet?: string;
  payload?: { headers?: GmailHeader[] };
};
export type RawGmailThread = { id: string; messages?: RawGmailMessage[] };

function getHeader(m: RawGmailMessage, name: string): string | undefined {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Extract + lowercase the address from a "Name <addr>" (or bare) From header. */
export function parseEmailAddress(headerValue: string): string | null {
  if (typeof headerValue !== 'string') return null;
  const angle = headerValue.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : headerValue).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

function parseDisplayName(headerValue: string): string | null {
  const m = headerValue.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = m ? m[1].trim() : '';
  return name || null;
}

/**
 * Did WE send this message? True for a SENT-labelled message OR one whose From is
 * our own mailbox. The latter is what neutralizes the self-ingest loop: an
 * escalation email delivered to sales@ has From: sales@, so it reads as "from us"
 * → outbound → the reducer skips it (never a fake lead).
 *
 * The identity object widens the check from a single address to our whole domain
 * (and any of its SUBDOMAINS — our own automated mail sends from
 * sales@mail.yulelovelights.com, #252) and any explicitly listed internal
 * addresses (e.g. sales@), so escalation emails sent from sub-addresses on our
 * domain never appear as fake leads. Domain matching itself delegates to the
 * shared classify.ts isFromUs so this can't drift from the other two adapters.
 */
export type GmailIdentity = { ourEmail: string; ourDomain?: string | null; internalAddrs?: string[] };

export function gmailMessageFromMe(m: RawGmailMessage, identity: GmailIdentity): boolean {
  if (m.labelIds?.includes('SENT')) return true;
  const from = getHeader(m, 'From');
  const addr = from ? parseEmailAddress(from) : null;
  if (!addr) return false;
  if (addr === identity.ourEmail.trim().toLowerCase()) return true;
  return isFromUs(addr, { ourDomain: identity.ourDomain, internalAddrs: identity.internalAddrs });
}

export function mapGmailThread(raw: RawGmailThread, identity: GmailIdentity): GmailThreadLite {
  const rawMessages = raw.messages ?? [];
  const messages: GmailMessageLite[] = rawMessages.map((m) => {
    const ms = Number(m.internalDate ?? 0);
    return {
      fromMe: gmailMessageFromMe(m, identity),
      // Guard against a non-numeric internalDate: an Invalid Date would later
      // throw at .toISOString() during the upsert.
      at: new Date(Number.isFinite(ms) ? ms : 0),
      snippet: m.snippet,
    };
  });
  const subject = rawMessages[0] ? getHeader(rawMessages[0], 'Subject') : undefined;
  // External party = the From of the latest inbound message on the thread.
  const latestInbound = [...rawMessages].reverse().find((m) => !gmailMessageFromMe(m, identity));
  const fromHeader = latestInbound ? getHeader(latestInbound, 'From') : undefined;
  const hasListUnsubscribe = rawMessages.some((m) => !!getHeader(m, 'List-Unsubscribe'));
  return {
    threadId: raw.id,
    subject,
    from: fromHeader
      ? { email: parseEmailAddress(fromHeader) ?? undefined, name: parseDisplayName(fromHeader) ?? undefined }
      : undefined,
    messages,
    hasListUnsubscribe,
  };
}

export function normalizeGmailThread(thread: GmailThreadLite, suppressed?: Set<string>): NormalizedTouch {
  const { lastInboundAt, lastOutboundAt, latest } = partition(thread.messages);
  const answered = isAnsweredByOutbound({ lastInboundAt, lastOutboundAt });
  const email = thread.from?.email ? normalizeEmail(thread.from.email) : null;
  const senderEmail = thread.from?.email;

  // #268: a known lead-forwarding platform (e.g. GML Media) whose body parses
  // out a real customer's phone/email wins over EVERY other signal — both
  // classify.ts's bulk-mail heuristics (a no-reply-shaped sender, List-
  // Unsubscribe) and layer-3 sender suppression. The live prod rows (7 as of
  // #268) are actually blocked by suppression today (the forwarder's address
  // is in dashboard.suppressedSenders, apparently added when staff mistook
  // its "automated"-tagged forwards for spam), not by List-Unsubscribe — so
  // the override has to run BEFORE the suppression check, not just before
  // classifyMessage, or it would never fire for the sender it exists to fix.
  const leadForward = parseLeadForward({
    fromAddress: thread.from?.email ?? null,
    displayName: thread.from?.name ?? null,
    body: latest?.snippet ?? null,
  });
  const leadKind =
    leadForward
      ? 'lead'
      : suppressed && senderEmail && suppressed.has(senderEmail.toLowerCase())
        ? 'automated'
        : classifyMessage({
            fromAddress: thread.from?.email ?? null,
            subject: thread.subject ?? null,
            preview: latest?.snippet ?? null,
            hasListUnsubscribe: thread.hasListUnsubscribe,
          });

  // #268: when the body parsed a real customer, build identity from THEM, not
  // the forwarding platform's own sender address/name — otherwise every
  // forward finds-or-creates onto the SAME forwarder contact, and contacting
  // the real customer can never auto-resolve the row. Uses only the existing
  // ContactIdentity fields; find-or-create's own matching is untouched.
  const identity = leadForward
    ? {
        ghlContactId: null,
        emails: leadForward.email ? [leadForward.email] : [],
        phones: leadForward.phone ? [leadForward.phone] : [],
        displayName: leadForward.name,
      }
    : {
        ghlContactId: null,
        emails: email ? [email] : [],
        phones: [],
        displayName: thread.from?.name ? normalizeName(thread.from.name) : null,
      };

  return {
    source: 'gmail',
    externalId: thread.threadId,
    sourceMessageId: null,
    direction: answered ? 'outbound' : 'inbound',
    channel: 'email',
    lastMessageAt: latest ? latest.at : new Date(0),
    preview: latest?.snippet ?? null,
    subject: thread.subject ?? null,
    identity,
    raw: thread,
    leadKind,
  };
}
