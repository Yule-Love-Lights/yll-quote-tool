import { describe, it, expect } from 'vitest';
import {
  gmailNeedsReply,
  normalizeGmailThread,
  normalizeGmailThreadTouches,
  parseEmailAddress,
  gmailMessageFromMe,
  mapGmailThread,
} from './gmail';
import type { GmailMessageLite, GmailThreadLite, RawGmailThread } from './gmail';

const msg = (fromMe: boolean, iso: string, snippet?: string, id?: string) => ({ fromMe, at: new Date(iso), snippet, id });

function thread(over: Partial<GmailThreadLite> = {}): GmailThreadLite {
  return {
    threadId: 'thr-1',
    subject: 'Holiday lights quote',
    from: { email: 'Cust@Example.com', name: 'A Customer' },
    messages: [msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?')],
    hasListUnsubscribe: false,
    ...over,
  };
}

describe('gmailNeedsReply — last message not from us', () => {
  it('is true when the customer sent the last message', () => {
    expect(gmailNeedsReply(thread().messages)).toBe(true);
  });
  it('is false when we replied after the customer (SENT after inbound)', () => {
    const messages = [msg(false, '2026-06-28T14:00:00Z'), msg(true, '2026-06-28T15:00:00Z', 'Sure!')];
    expect(gmailNeedsReply(messages)).toBe(false);
  });
});

describe('normalizeGmailThread — thread → NormalizedTouch', () => {
  it('marks an unanswered thread inbound with the customer identity', () => {
    const t = normalizeGmailThread(thread());
    expect(t.source).toBe('gmail');
    expect(t.externalId).toBe('thr-1');
    expect(t.direction).toBe('inbound');
    expect(t.channel).toBe('email');
    expect(t.subject).toBe('Holiday lights quote');
    expect(t.preview).toBe('Can I get a quote?');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-28T14:00:00.000Z');
    expect(t.identity.emails).toEqual(['cust@example.com']); // normalized
    expect(t.identity.displayName).toBe('A Customer');
  });

  it('marks a replied thread outbound (drives auto-resolve) using the latest message', () => {
    const t = normalizeGmailThread(
      thread({
        messages: [
          msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?'),
          msg(true, '2026-06-28T15:30:00Z', 'Absolutely — here it is'),
        ],
      }),
    );
    expect(t.direction).toBe('outbound');
    expect(t.preview).toBe('Absolutely — here it is');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-28T15:30:00.000Z');
  });

  // #303: an ordinary (non-lead-forward, 0-parsed) thread used to hardcode
  // sourceMessageId: null unconditionally, which starved the Handled
  // write-back (sync.ts's runHandledWriteback) of a message id for the
  // overwhelming majority of Gmail traffic. It now carries the last INBOUND
  // (customer) message's id, so the write-back can act message-level here too.
  it('carries the last inbound message id as sourceMessageId, so the message-level Handled write-back can act on an ordinary thread (#303)', () => {
    const t = normalizeGmailThread(
      thread({ messages: [msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?', 'm-cust-1')] }),
    );
    expect(t.sourceMessageId).toBe('m-cust-1');
  });

  // #303: deliberately NOT thread.partition().latest — if staff already
  // replied directly in Gmail (the thread's chronologically-latest message is
  // OURS) and then click "Handled" ("closed as answered" — InboxList.tsx's
  // own button title), targeting our own SENT message would be a no-op
  // (already read, and a staffer checking raw Gmail wants the CUSTOMER'S
  // message labeled/cleared, not their own reply). sourceMessageId stays
  // pinned to the customer's own last message regardless of who replied last.
  it("stays pinned to the CUSTOMER's last message when we already replied — never our own latest outbound reply (#303)", () => {
    const t = normalizeGmailThread(
      thread({
        messages: [
          msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?', 'm-cust-1'),
          msg(true, '2026-06-28T15:30:00Z', 'Absolutely — here it is', 'm-us-1'),
        ],
      }),
    );
    expect(t.direction).toBe('outbound');
    expect(t.sourceMessageId).toBe('m-cust-1');
  });

  // Edge case: a thread with no inbound message at all (every message
  // fromMe) has nothing for the write-back to target — stays null rather than
  // mislabeling one of our own sent messages.
  it('has a null sourceMessageId when the thread has no inbound message at all (#303)', () => {
    const t = normalizeGmailThread(thread({ messages: [msg(true, '2026-06-28T14:00:00Z', 'note to self', 'm-us-1')] }));
    expect(t.sourceMessageId).toBe(null);
  });
});

describe('parseEmailAddress', () => {
  it('extracts + lowercases the address from a "Name <addr>" header', () => {
    expect(parseEmailAddress('Jane Doe <Jane@Example.com>')).toBe('jane@example.com');
  });
  it('handles a bare address', () => {
    expect(parseEmailAddress('jane@example.com')).toBe('jane@example.com');
  });
  it('returns null when there is no address', () => {
    expect(parseEmailAddress('no address here')).toBeNull();
  });
});

const OUR = 'sales@yulelovelights.com';
function gm(over: Partial<{ labelIds: string[]; internalDate: string; snippet: string; from: string; subject: string }> = {}) {
  return {
    id: `m-${over.internalDate ?? '1'}`,
    labelIds: over.labelIds,
    internalDate: over.internalDate ?? '1782693272654',
    snippet: over.snippet,
    payload: {
      headers: [
        { name: 'From', value: over.from ?? 'A Customer <cust@example.com>' },
        { name: 'Subject', value: over.subject ?? 'Holiday lights' },
      ],
    },
  };
}

describe('gmailMessageFromMe', () => {
  it('is true for a SENT-labelled message', () => {
    expect(gmailMessageFromMe(gm({ labelIds: ['SENT'], from: 'cust@example.com' }), { ourEmail: OUR })).toBe(true);
  });
  it('is true when the From address is our mailbox (e.g. an escalation email in sales@)', () => {
    expect(gmailMessageFromMe(gm({ from: 'Yule Love Lights <sales@yulelovelights.com>' }), { ourEmail: OUR })).toBe(true);
  });
  it('is false for a customer message', () => {
    expect(gmailMessageFromMe(gm({ from: 'cust@example.com' }), { ourEmail: OUR })).toBe(false);
  });

  // #252: our own automated mail (marketing sends, "Quote viewed" alerts, the
  // escalation email, the EOD digest) sends from sales@mail.yulelovelights.com
  // — a subdomain of ourDomain, not an exact match.
  it('is true for a sender on a SUBDOMAIN of ourDomain (the live sales@mail.yulelovelights.com shape)', () => {
    expect(
      gmailMessageFromMe(gm({ from: 'Yule Love Lights <sales@mail.yulelovelights.com>' }), {
        ourEmail: OUR,
        ourDomain: 'yulelovelights.com',
      }),
    ).toBe(true);
  });

  // GMAIL_USER is a masked prod env var nobody here can read — the self-ingest
  // filter must hold even when ourDomain never got derived from it (falls back
  // to classify.ts's static internal-domain list).
  it('is true for our subdomain even when ourDomain is unset (GMAIL_USER-unset shape)', () => {
    expect(gmailMessageFromMe(gm({ from: 'sales@mail.yulelovelights.com' }), { ourEmail: 'me' })).toBe(true);
  });

  it('does NOT match a lookalike domain (notyulelovelights.com)', () => {
    expect(
      gmailMessageFromMe(gm({ from: 'anyone@notyulelovelights.com' }), { ourEmail: OUR, ourDomain: 'yulelovelights.com' }),
    ).toBe(false);
  });
});

describe('mapGmailThread — raw Gmail payload → GmailThreadLite', () => {
  it('maps an unanswered customer thread to inbound with the customer identity', () => {
    const raw: RawGmailThread = {
      id: 'thr-1',
      messages: [gm({ internalDate: '1782690000000', from: 'A Customer <cust@example.com>', subject: 'Quote?', snippet: 'Can I get a quote?' })],
    };
    const t = normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR }));
    expect(t.source).toBe('gmail');
    expect(t.externalId).toBe('thr-1');
    expect(t.direction).toBe('inbound');
    expect(t.subject).toBe('Quote?');
    expect(t.identity.emails).toEqual(['cust@example.com']);
    expect(t.identity.displayName).toBe('A Customer');
  });

  it('maps a replied thread to outbound (our SENT after the customer)', () => {
    const raw: RawGmailThread = {
      id: 'thr-2',
      messages: [
        gm({ internalDate: '1782690000000', from: 'cust@example.com', snippet: 'hi' }),
        gm({ internalDate: '1782693000000', labelIds: ['SENT'], from: OUR, snippet: 'replied' }),
      ],
    };
    const t = normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR }));
    expect(t.direction).toBe('outbound');
    // #303 end-to-end through the real raw-payload mapper: sourceMessageId is
    // the CUSTOMER's raw message id (gm() auto-ids as `m-<internalDate>`),
    // not our own SENT message's id.
    expect(t.sourceMessageId).toBe('m-1782690000000');
  });

  it('never produces an Invalid Date from a malformed internalDate (would crash .toISOString)', () => {
    const raw: RawGmailThread = {
      id: 'thr-bad',
      messages: [gm({ internalDate: 'not-a-number', from: 'cust@example.com', snippet: 'hi' })],
    };
    const t = normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR }));
    expect(Number.isNaN(t.lastMessageAt.getTime())).toBe(false);
    expect(() => t.lastMessageAt.toISOString()).not.toThrow();
  });

  it('treats any sender on our domain as from-us (kills the escalation self-ingest)', () => {
    const raw = {
      id: 't1',
      messages: [
        { id: 'm1', labelIds: ['INBOX'], internalDate: '1000',
          payload: { headers: [{ name: 'From', value: 'Yule Love Lights <sales@yulelovelights.com>' }, { name: 'Subject', value: 'URGENT: 28 customer messages still unanswered' }] } },
      ],
    };
    const thread = mapGmailThread(raw, { ourEmail: 'info@yulelovelights.com', ourDomain: 'yulelovelights.com', internalAddrs: ['sales@yulelovelights.com'] });
    expect(thread.messages[0].fromMe).toBe(true);
  });

  it('sets hasListUnsubscribe true when any message has that header', () => {
    const raw: RawGmailThread = {
      id: 'thr-unsub',
      messages: [
        {
          id: 'm1',
          internalDate: '1782690000000',
          snippet: 'View online / Unsubscribe',
          payload: {
            headers: [
              { name: 'From', value: 'newsletter@marketing.com' },
              { name: 'Subject', value: 'Your weekly digest' },
              { name: 'List-Unsubscribe', value: '<mailto:unsub@marketing.com>' },
            ],
          },
        },
      ],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.hasListUnsubscribe).toBe(true);
    expect(normalizeGmailThread(mapped).leadKind).toBe('automated');
  });

  it('sets hasListUnsubscribe false and leadKind lead for a normal customer thread', () => {
    const raw: RawGmailThread = {
      id: 'thr-cust',
      messages: [gm({ internalDate: '1782690000000', from: 'A Customer <cust@example.com>', subject: 'Quote request', snippet: 'Hi, can I get a quote?' })],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.hasListUnsubscribe).toBe(false);
    expect(normalizeGmailThread(mapped).leadKind).toBe('lead');
  });
});

describe('normalizeGmailThread — #268 GML-Media lead-forward override', () => {
  // Synthetic — mirrors the real prod body shape (verified via Supabase for
  // #268) with a fake name/phone/email. Never real customer PII in git history.
  const GML_BODY =
    'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com Street Address: 42 Fake Lane City: Faketown Areas to light up: Roof Line + Roof Ridges - (Premium Package)';

  const gmlThread = (over: Partial<GmailThreadLite> = {}) =>
    thread({
      from: { email: 'no-reply.fake123@zapiermail.com', name: 'GML Media' },
      subject: 'New Lead from GML Media - Jamie Test',
      messages: [msg(false, '2026-08-12T14:00:00Z', GML_BODY)],
      ...over,
    });

  it('classifies as lead even when the platform sets List-Unsubscribe (defeats classify.ts\'s bulk-mail heuristic)', () => {
    const t = normalizeGmailThread(gmlThread({ hasListUnsubscribe: true }));
    expect(t.leadKind).toBe('lead');
  });

  it('classifies as lead even when the sender is in the suppression set — the REAL prod blocker for the observed GML address (verified live: no-reply.mj1fi9@zapiermail.com IS in dashboard.suppressedSenders)', () => {
    const t = normalizeGmailThread(gmlThread(), new Set(['no-reply.fake123@zapiermail.com']));
    expect(t.leadKind).toBe('lead');
  });

  it('extracts identity from the PARSED CUSTOMER, not the GML Media forwarder sender', () => {
    const t = normalizeGmailThread(gmlThread());
    expect(t.identity.displayName).toBe('Jamie Test');
    expect(t.identity.emails).toEqual(['jamie.test@example.com']);
    expect(t.identity.phones).toEqual(['+15551234567']);
  });

  it('the SAME forward body from an UNKNOWN sender (not a known platform) is unaffected — falls through to normal classification', () => {
    const t = normalizeGmailThread(
      gmlThread({ from: { email: 'someone@unknown-relay.example.com', name: 'Someone' }, hasListUnsubscribe: true }),
    );
    expect(t.leadKind).toBe('automated'); // hasListUnsubscribe still governs — no platform matched, no override
    expect(t.identity.displayName).toBe('Someone'); // identity stays the sender's — no parse ran
  });

  it('a GML Media message with no parseable phone/email (fail-closed) falls through to unchanged classify/suppression behavior', () => {
    const t = normalizeGmailThread(
      gmlThread({
        messages: [msg(false, '2026-08-12T14:00:00Z', 'Thanks for using GML Media! Your monthly statement is attached.')],
        hasListUnsubscribe: true,
      }),
    );
    expect(t.leadKind).toBe('automated'); // no override fired — same as pre-#268 behavior
  });

  // #268 fix round 3 (LOW 1): the top-of-file "residual, accepted risk" note
  // names the worst case as contamination of an EXISTING contact (a forged
  // template whose phone matches a real customer's, paired with an
  // attacker-chosen email). This module's boundary is faithfully reporting
  // what the message says — it never looks up or merges with any existing
  // contact. Whether a phone match against an existing dashboard_contacts
  // row causes a union is identity.ts's resolveIdentity/appendIdentifiers +
  // store.ts's ingestTouch (both out of this module's reach, and store.ts is
  // embargoed this round) — pin that this layer's output IS the forged
  // identity verbatim, not that it's safe end-to-end.
  it('a forged both-legs message whose phone matches a known real customer produces a touch identity that IS the forged data — the union/merge decision is downstream, not here', () => {
    const KNOWN_CUSTOMER_PHONE = '+15551234567'; // stands in for a real existing contact's phone
    const forgedBody = `Here ya go Naldoven: Totally Legit ${KNOWN_CUSTOMER_PHONE} Email: attacker@evil.example.com`;
    const t = normalizeGmailThread(gmlThread({ messages: [msg(false, '2026-08-12T14:00:00Z', forgedBody)] }));
    expect(t.leadKind).toBe('lead');
    expect(t.identity.phones).toEqual([KNOWN_CUSTOMER_PHONE]);
    expect(t.identity.emails).toEqual(['attacker@evil.example.com']);
  });
});

describe('normalizeGmailThread — sender-suppression set (layer 3)', () => {
  it('classifies a suppressed sender as automated regardless of content', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('automated');
  });

  it('is case-insensitive when matching the suppressed email', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'Spam@Vendor.com', name: 'Vendor' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('automated');
  });

  it('classifies as lead when the sender is NOT in the suppressed set', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'legit@customer.com', name: 'Legit Customer' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('lead');
  });

  it('classifies normally (by content) when suppressed set is undefined', () => {
    // no suppressed arg — should fall through to classifyMessage
    const t = normalizeGmailThread(thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }));
    expect(t.leadKind).toBe('lead'); // no automated signals in the default thread fixture
  });

  it('classifies normally when suppressed set is empty', () => {
    const t = normalizeGmailThread(thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }), new Set());
    expect(t.leadKind).toBe('lead');
  });
});

describe('mapGmailThread — per-message id/fromEmail/fromName (#288)', () => {
  it("carries the raw message id and this message's own From address/display name", () => {
    const raw: RawGmailThread = {
      id: 'thr-per-msg',
      messages: [
        gm({
          internalDate: '1782690000000',
          from: 'A Customer <cust@example.com>',
          subject: 'Quote?',
          snippet: 'Can I get a quote?',
        }),
      ],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.messages[0].id).toBe('m-1782690000000');
    expect(mapped.messages[0].fromEmail).toBe('cust@example.com');
    expect(mapped.messages[0].fromName).toBe('A Customer');
  });

  it('leaves fromEmail/fromName null when the message has no From header', () => {
    const raw: RawGmailThread = { id: 'thr-no-from', messages: [{ id: 'm1', internalDate: '1000', payload: { headers: [] } }] };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.messages[0].fromEmail).toBeNull();
    expect(mapped.messages[0].fromName).toBeNull();
  });
});

// #288: Zapier's GML Media relay reuses the exact same subject ("New Lead from
// GML Media!") for EVERY forwarded lead, so Gmail coalesces DISTINCT customers'
// forwards into ONE thread. normalizeGmailThread (above) is thread-level: it
// collapses a multi-customer thread into a single touch keyed by threadId, so
// every customer after the first gets no item/contact, and the surviving item's
// preview/identity drift toward whichever message is thread-latest.
// normalizeGmailThreadTouches is the per-message-aware sibling — see its doc
// comment in gmail.ts for the full design.
describe('normalizeGmailThreadTouches — per-message split for coalesced GML threads (#288)', () => {
  // Synthetic fixtures only — never real customer PII (repo precedent, #268).
  const GML_FROM_EMAIL = 'no-reply.fake123@zapiermail.com';
  const GML_FROM_NAME = 'GML Media';

  function gmlMsg(over: {
    iso: string;
    id?: string;
    body: string;
    fromMe?: boolean;
    fromEmail?: string | null;
    fromName?: string | null;
  }): GmailMessageLite {
    return {
      fromMe: over.fromMe ?? false,
      at: new Date(over.iso),
      snippet: over.body,
      id: over.id,
      fromEmail: over.fromEmail === undefined ? GML_FROM_EMAIL : over.fromEmail,
      fromName: over.fromName === undefined ? GML_FROM_NAME : over.fromName,
    };
  }

  function gmlThreadLite(messages: GmailMessageLite[], over: Partial<GmailThreadLite> = {}): GmailThreadLite {
    return {
      threadId: 'thr-gml',
      subject: 'New Lead from GML Media!',
      from: { email: GML_FROM_EMAIL, name: GML_FROM_NAME },
      hasListUnsubscribe: false,
      messages,
      ...over,
    };
  }

  const ALICE_BODY =
    'Here ya go Naldoven: Alice Anderson +15550001111 Email: alice@example.com Street Address: 1 Test Rd City: Testville Areas to light up: Roofline';
  const BOB_BODY =
    'Here ya go Naldoven: Bob Baker +15550002222 Email: bob@example.com Street Address: 2 Test Rd City: Testville Areas to light up: Roofline';
  const CAROL_BODY =
    'Here ya go Naldoven: Carol Clark +15550003333 Email: carol@example.com Street Address: 3 Test Rd City: Testville Areas to light up: Roofline';

  it('(b) a non-GML thread returns exactly [normalizeGmailThread(thread)] — unchanged single-touch shape', () => {
    const t = thread();
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toEqual([normalizeGmailThread(t)]);
  });

  it('a thread with zero parseable lead-forward messages (no known platform at all) also falls through unchanged', () => {
    const t = thread({ messages: [msg(false, '2026-08-01T10:00:00Z', 'Just a normal reply, thanks!')] });
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toEqual([normalizeGmailThread(t)]);
  });

  it("(c) a single GML forward → one touch, bare threadId, identity from the parsed customer (today's single-customer outcome preserved)", () => {
    const t = gmlThreadLite([gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY })]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].source).toBe('gmail');
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].direction).toBe('inbound');
    expect(touches[0].channel).toBe('email');
    expect(touches[0].leadKind).toBe('lead');
    expect(touches[0].subject).toBe('New Lead from GML Media!');
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].identity.emails).toEqual(['alice@example.com']);
    expect(touches[0].identity.phones).toEqual(['+15550001111']);
  });

  it('(d) three forwards from three distinct customers coalesced onto one thread → three touches, each independently keyed/identified, sorted chronologically regardless of input order', () => {
    const t = gmlThreadLite([
      // Deliberately out of chronological order to prove the function sorts
      // rather than trusting message array order.
      gmlMsg({ iso: '2026-08-14T09:00:00Z', id: 'm3', body: CAROL_BODY }),
      gmlMsg({ iso: '2026-08-12T09:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({ iso: '2026-08-13T09:00:00Z', id: 'm2', body: BOB_BODY }),
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(3);

    // Earliest keeps the bare threadId (continuity with any existing prod row).
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].lastMessageAt.toISOString()).toBe('2026-08-12T09:00:00.000Z');
    expect(touches[0].preview).toBe(ALICE_BODY);
    expect(touches[0].sourceMessageId).toBe('m1');

    // Later ones get a composite external_id, never seen before → new item + new contact.
    expect(touches[1].externalId).toBe('thr-gml:m2');
    expect(touches[1].identity.displayName).toBe('Bob Baker');
    expect(touches[1].identity.emails).toEqual(['bob@example.com']);
    expect(touches[1].lastMessageAt.toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(touches[1].preview).toBe(BOB_BODY);

    expect(touches[2].externalId).toBe('thr-gml:m3');
    expect(touches[2].identity.displayName).toBe('Carol Clark');
    expect(touches[2].identity.emails).toEqual(['carol@example.com']);
    expect(touches[2].lastMessageAt.toISOString()).toBe('2026-08-14T09:00:00.000Z');
    expect(touches[2].preview).toBe(CAROL_BODY);

    for (const touch of touches) {
      expect(touch.direction).toBe('inbound');
      expect(touch.leadKind).toBe('lead');
      expect(touch.channel).toBe('email');
      expect(touch.subject).toBe('New Lead from GML Media!');
      expect(touch.source).toBe('gmail');
    }
  });

  // #288 fix round (two-lens HIGH): exactly ONE parsed message is the HYBRID
  // shape — identity/preview from the parsed forward, but direction mirrors
  // the THREAD-WIDE needs-reply check, so a later fromMe reaction/reply still
  // auto-resolves the row exactly like it does today via normalizeGmailThread.
  // An earlier version of this function hardcoded 'inbound' even here, which
  // would have silently broken that for every single-customer GML thread.
  it('(e) a single forward + our own fromMe reaction after it → direction follows the THREAD (outbound, auto-resolve preserved); identity stays the customer\'s, not the reaction', () => {
    const REACTION_BODY =
      '🎄 Yule Love Lights Sales reacted via Gmail On Wed, Aug 12, 2026 at 2:46 PM GML Media &lt;no-reply.fake123@zapiermail.com&gt; wrote: ' +
      ALICE_BODY;
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({
        iso: '2026-08-12T15:00:00Z',
        id: 'm2',
        body: REACTION_BODY,
        fromMe: true,
        fromEmail: 'sales@yulelovelights.com',
        fromName: 'Yule Love Lights Sales',
      }),
    ]);

    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1); // the reaction itself is still not a touch
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].sourceMessageId).toBe('m1'); // the forward's id, not the reaction's
    expect(touches[0].direction).toBe('outbound'); // auto-resolve preserved, matching normalizeGmailThread
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].leadKind).toBe('lead');
    // #288 fix round 3 (HIGH, reopen-starvation precondition): with no further
    // real inbound after the reaction, lastMessageAt stays the forward's own
    // time (the same value partition().lastInboundAt derives here too, since
    // the forward is still the only non-fromMe message) — this pins the
    // steady-state noop planIngest relies on so re-polling this exact thread
    // forever doesn't re-write the same row.
    expect(touches[0].lastMessageAt.toISOString()).toBe('2026-08-12T14:00:00.000Z');

    // Same direction as today's thread-level function on this thread — the
    // hybrid's job is to match it, not diverge from it.
    expect(normalizeGmailThread(t).direction).toBe('outbound');
  });

  // #288 fix round 3 (HIGH): buildLeadForwardTouch used to derive lastMessageAt
  // from msg.at — the ORIGINAL forward's own timestamp, FROZEN forever once the
  // hybrid branch is taken, because a genuine customer follow-up reply never
  // re-matches the "Here ya go...: ... Areas to light up:" template (parsed
  // stays length 1, still keyed to the same forward). Consequence: after a
  // reaction auto-resolves the row to 'handled' (see (e) above), a REAL reply
  // at T2 could never advance lastMessageAt past the forward's T0, so
  // decideInboxState's `newerInbound` check (touch.lastMessageAt >
  // existing.lastMessageAt) was false, the row stayed 'handled', and
  // planIngest's noopReingest swallowed the write outright — the customer's
  // reply vanished with zero signal anywhere, permanently. lastMessageAt now
  // reuses the SAME partition() call the hybrid branch already runs for
  // direction, taking lastInboundAt (the thread-wide latest NON-fromMe
  // message) instead of the pinned forward's own timestamp.
  it('a genuine non-template inbound reply AFTER a reaction reopens the row: direction flips back to inbound and lastMessageAt advances to the reply, while identity/preview/sourceMessageId stay pinned to the original forward', () => {
    const REACTION_BODY =
      '🎄 Yule Love Lights Sales reacted via Gmail On Wed, Aug 12, 2026 at 2:46 PM GML Media &lt;no-reply.fake123@zapiermail.com&gt; wrote: ' +
      ALICE_BODY;
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({
        iso: '2026-08-12T15:00:00Z',
        id: 'm2',
        body: REACTION_BODY,
        fromMe: true,
        fromEmail: 'sales@yulelovelights.com',
        fromName: 'Yule Love Lights Sales',
      }),
      // The customer's own free-text reply — never matches the lead-forward
      // template, so it can never become its own parsed candidate.
      gmlMsg({
        iso: '2026-08-12T16:00:00Z',
        id: 'm3',
        body: 'Thanks! When can you come by to take a look?',
        fromEmail: 'jane.customer@example.com',
        fromName: 'Jane Customer',
      }),
    ]);

    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1); // still exactly one touch — parsed.length is still 1
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].direction).toBe('inbound'); // unanswered again — the reply is newer than the reaction
    expect(touches[0].lastMessageAt.toISOString()).toBe('2026-08-12T16:00:00.000Z'); // the REPLY's time, not the forward's
    // Pinned to the original parsed forward — NOT the customer's reply text,
    // and NOT the forwarder's own identity. This is the whole point of #288;
    // the reopen fix must not disturb it.
    expect(touches[0].sourceMessageId).toBe('m1');
    expect(touches[0].preview).toBe(ALICE_BODY);
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].identity.emails).toEqual(['alice@example.com']);
  });

  it("the hybrid's actual advantage over a true fallback: identity never regresses to the forwarder even when the THREAD-LATEST message's own snippet fails to parse", () => {
    // A reaction-quote so heavily truncated (no "Areas to light up:" marker
    // within TEMPLATE_MAX_LEN_WITHOUT_CLOSING_MARKER) that parseLeadForward
    // fails on ITS OWN snippet — the real Gmail truncation failure mode
    // leadForward.ts's own comments describe. normalizeGmailThread (which
    // parses only the thread-LATEST message's snippet) falls back to the
    // forwarder's own identity here; the hybrid (which parses the ORIGINAL
    // forward's own untruncated snippet) does not.
    const TRUNCATED_REACTION_BODY =
      '🎄 Yule Love Lights Sales reacted via Gmail On Wed, Aug 12, 2026 at 2:46 PM GML Media &lt;no-reply.fake123@zapiermail.com&gt; wrote: Here ya go Naldoven: ' +
      'x'.repeat(320);
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({
        iso: '2026-08-12T15:00:00Z',
        id: 'm2',
        body: TRUNCATED_REACTION_BODY,
        fromMe: true,
        fromEmail: 'sales@yulelovelights.com',
        fromName: 'Yule Love Lights Sales',
      }),
    ]);

    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].direction).toBe('outbound'); // still thread-wide, still auto-resolves
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].identity.emails).toEqual(['alice@example.com']);

    // Contrast: today's thread-level function, parsing only the (truncated,
    // unparseable) latest snippet, regresses to the FORWARDER's own identity.
    const oldTouch = normalizeGmailThread(t);
    expect(oldTouch.identity.displayName).not.toBe('Alice Anderson');
  });

  it('(d contrast) with 2+ parsed forwards, a later fromMe reaction never flips ANY split touch to outbound — always-inbound stays load-bearing there', () => {
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T09:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({ iso: '2026-08-13T09:00:00Z', id: 'm2', body: BOB_BODY }),
      gmlMsg({
        iso: '2026-08-13T10:00:00Z',
        id: 'm3',
        body: 'reacted via Gmail — wrote: ' + BOB_BODY,
        fromMe: true,
        fromEmail: 'sales@yulelovelights.com',
        fromName: 'Yule Love Lights Sales',
      }),
    ]);

    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(2); // the reaction is still not a touch
    expect(touches[0].direction).toBe('inbound');
    expect(touches[1].direction).toBe('inbound');
  });

  it('(f) a platform message that fails the template parse (a receipt) is not a touch, even alongside a real forward on the same thread — direction is unanswered inbound (the receipt is non-fromMe, no fromMe message anywhere on the thread)', () => {
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({ iso: '2026-08-12T16:00:00Z', id: 'm2', body: 'Thanks for using GML Media! Your monthly statement is attached.' }),
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].direction).toBe('inbound');
  });

  it('(fix round, technical MED) a tied `at` timestamp breaks on a locale-aware compare of the message id, so "earliest" cannot flip across polls on Gmail API array order alone', () => {
    const TIED_ISO = '2026-08-12T09:00:00Z';
    const aliceFirst = gmlMsg({ iso: TIED_ISO, id: 'm-aaa', body: ALICE_BODY });
    const bobSecond = gmlMsg({ iso: TIED_ISO, id: 'm-zzz', body: BOB_BODY });

    const orderAliceThenBob = normalizeGmailThreadTouches(gmlThreadLite([aliceFirst, bobSecond]));
    const orderBobThenAlice = normalizeGmailThreadTouches(gmlThreadLite([bobSecond, aliceFirst]));

    // 'm-aaa'.localeCompare('m-zzz') < 0 (equivalent to codepoint order for
    // lowercase-hex ids) — Alice wins the bare threadId key regardless of
    // which order the Gmail API happened to hand the messages back in.
    expect(orderAliceThenBob).toHaveLength(2);
    expect(orderAliceThenBob[0].externalId).toBe('thr-gml');
    expect(orderAliceThenBob[0].identity.displayName).toBe('Alice Anderson');
    expect(orderAliceThenBob[1].externalId).toBe('thr-gml:m-zzz');

    expect(orderBobThenAlice).toHaveLength(2);
    expect(orderBobThenAlice[0].externalId).toBe('thr-gml');
    expect(orderBobThenAlice[0].identity.displayName).toBe('Alice Anderson');
    expect(orderBobThenAlice[1].externalId).toBe('thr-gml:m-zzz');
  });

  it('a later (non-earliest) parsed message with no id is skipped defensively rather than minting an unstable key', () => {
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T09:00:00Z', id: 'm1', body: ALICE_BODY }),
      { fromMe: false, at: new Date('2026-08-13T09:00:00Z'), snippet: BOB_BODY, fromEmail: GML_FROM_EMAIL, fromName: GML_FROM_NAME }, // no id
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
  });
});
