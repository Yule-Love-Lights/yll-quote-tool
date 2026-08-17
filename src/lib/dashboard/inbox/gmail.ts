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
import { parseLeadForward, type ParsedLeadForward } from './leadForward';

export type GmailMessageLite = {
  /** Did the YLL workspace account send this message (a SENT message). */
  fromMe: boolean;
  at: Date;
  snippet?: string;
  /** Gmail's own message id (RawGmailMessage.id). Optional: only
   *  mapGmailThread-derived messages carry it; hand-built test fixtures may
   *  omit it. #288: used by normalizeGmailThreadTouches to mint a stable
   *  composite external_id for a non-earliest customer in a coalesced
   *  lead-forward thread. */
  id?: string;
  /** This message's OWN From address/display name — distinct from
   *  GmailThreadLite.from, which is the LATEST INBOUND message's From (see
   *  mapGmailThread below). #288: needed so a per-message lead-forward parse
   *  can use the sender of THIS message, not whichever message happens to be
   *  thread-latest. */
  fromEmail?: string | null;
  fromName?: string | null;
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
// them into the source-agnostic GmailThreadLite that normalizeGmailThread /
// normalizeGmailThreadTouches (#288) + the reducer consume.

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
    const fromHeader = getHeader(m, 'From');
    return {
      fromMe: gmailMessageFromMe(m, identity),
      // Guard against a non-numeric internalDate: an Invalid Date would later
      // throw at .toISOString() during the upsert.
      at: new Date(Number.isFinite(ms) ? ms : 0),
      snippet: m.snippet,
      id: m.id,
      // #288: this message's OWN From, independent of the thread-level `from`
      // computed below (which is the LATEST INBOUND message's From).
      fromEmail: fromHeader ? parseEmailAddress(fromHeader) : null,
      fromName: fromHeader ? parseDisplayName(fromHeader) : null,
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
  //
  // OPS NOTE (#268 fix round, admin MED): the zapiermail.com suppression
  // entry in app_settings (dashboard.suppressedSenders) is LOAD-BEARING for
  // the FAILED-parse fallback and must NOT be deleted as "stale" once this
  // fix ships. classify.ts's NO_REPLY_RE requires the no-reply-ish token to
  // be immediately followed by "@" (`^no[-_.]?reply@`); the real GML address
  // is `no-reply.<token>@zapiermail.com` — the token sits BETWEEN "reply" and
  // "@", so NO_REPLY_RE does not match it. That means a future GML
  // receipt/digest that doesn't parse (leadForward returns null) would
  // classify as a 'lead' by content alone without the suppression entry.
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

/**
 * #288: Zapier's GML Media relay reuses the exact same subject ("New Lead
 * from GML Media!") for EVERY forwarded lead, so Gmail coalesces DISTINCT
 * customers' lead-forward emails into ONE thread. normalizeGmailThread
 * (above) is thread-level — it collapses a multi-customer thread into a
 * single touch keyed by thread.threadId, so every customer after the first
 * gets no inbox item and no contact (invisible to every count/filter/
 * search), and the surviving item's preview/subject drift toward whichever
 * message is thread-latest while its contact link stays whichever customer
 * arrived first — staff working the row as displayed call the wrong person.
 *
 * This is the per-message-aware sibling: it detects when a thread carries
 * MULTIPLE distinct parseable lead-forward messages and, only then, emits
 * one NormalizedTouch PER parsed message instead of one for the whole
 * thread. A thread with zero or exactly one parseable lead-forward message —
 * i.e. everything that ISN'T a coalesced multi-customer GML thread, the
 * overwhelming majority of Gmail traffic — falls straight through to
 * normalizeGmailThread, byte-for-byte: this function is additive, never a
 * rewrite of the existing single-touch path.
 *
 * Keying: the EARLIEST parsed message keeps the bare thread.threadId, so an
 * existing prod row (created back when its thread had only one message)
 * keeps resolving to the SAME item on re-ingest — planIngest's
 * keep-existing-contact-for-an-existing-item rule then re-aligns that item's
 * preview/subject/last_message_at back to the FIRST customer's own message,
 * self-healing a row that currently displays one customer while linked to
 * another's contact. Every LATER parsed message gets a brand-new
 * `${threadId}:${msgId}` composite external_id (colon-suffix precedent:
 * store.ts's quoteIdPrefix for `${quoteId}:color-request` — that helper
 * itself is quotetool/uuid-specific and not reused here) — never seen
 * before, so it inserts a fresh item + a fresh contact. UNIQUE(source,
 * external_id) is a bare text column (migrations/2026-06-28-dashboard-
 * tables.sql), so a composite string needs no schema change.
 *
 * direction is hardcoded 'inbound' for every split touch, never derived from
 * whether some other message on the thread is outbound. Rationale: an
 * on-thread reply lands on the platform's no-reply relay
 * (no-reply.<token>@zapiermail.com) and reaches NO customer, so it must
 * never be read as "answered" — that would incorrectly auto-resolve/bury one
 * customer's forward just because a DIFFERENT, later customer's forward (or
 * our own reaction to one) happened to be the thread's chronologically-last
 * message. A split touch only resolves by actually contacting that customer
 * (cross-channel) or a manual dismiss/handle.
 */
export function normalizeGmailThreadTouches(thread: GmailThreadLite, suppressed?: Set<string>): NormalizedTouch[] {
  const parsed = thread.messages
    .filter((m) => !m.fromMe)
    .map((m) => ({
      msg: m,
      lead: parseLeadForward({ fromAddress: m.fromEmail, displayName: m.fromName, body: m.snippet ?? null }),
    }))
    .filter((c): c is { msg: GmailMessageLite; lead: ParsedLeadForward } => c.lead !== null)
    .sort((a, b) => a.msg.at.getTime() - b.msg.at.getTime());

  if (parsed.length === 0) return [normalizeGmailThread(thread, suppressed)];

  const touches: NormalizedTouch[] = [];
  parsed.forEach(({ msg, lead }, index) => {
    // A later (non-earliest) parsed message with no id can't mint a stable
    // composite key — skip it rather than risk colliding with (or silently
    // overwriting) the earliest touch's bare-threadId item. Real Gmail
    // payloads always carry RawGmailMessage.id; this only guards hand-built/
    // malformed input.
    if (index > 0 && !msg.id) return;
    const externalId = index === 0 ? thread.threadId : `${thread.threadId}:${msg.id}`;
    touches.push({
      source: 'gmail',
      externalId,
      sourceMessageId: msg.id ?? null,
      direction: 'inbound',
      channel: 'email',
      lastMessageAt: msg.at,
      preview: msg.snippet ?? null,
      subject: thread.subject ?? null,
      identity: {
        ghlContactId: null,
        emails: lead.email ? [lead.email] : [],
        phones: lead.phone ? [lead.phone] : [],
        displayName: lead.name,
      },
      raw: thread,
      leadKind: 'lead',
    });
  });
  return touches;
}
