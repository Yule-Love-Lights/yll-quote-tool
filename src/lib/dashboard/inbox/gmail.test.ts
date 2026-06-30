import { describe, it, expect } from 'vitest';
import {
  gmailNeedsReply,
  normalizeGmailThread,
  parseEmailAddress,
  gmailMessageFromMe,
  mapGmailThread,
} from './gmail';
import type { GmailThreadLite, RawGmailThread } from './gmail';

const msg = (fromMe: boolean, iso: string, snippet?: string) => ({ fromMe, at: new Date(iso), snippet });

function thread(over: Partial<GmailThreadLite> = {}): GmailThreadLite {
  return {
    threadId: 'thr-1',
    subject: 'Holiday lights quote',
    from: { email: 'Cust@Example.com', name: 'A Customer' },
    messages: [msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?')],
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
    expect(normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR })).direction).toBe('outbound');
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
});
