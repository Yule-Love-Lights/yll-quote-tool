import { describe, it, expect } from 'vitest';
import { gmailNeedsReply, normalizeGmailThread } from './gmail';
import type { GmailThreadLite } from './gmail';

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
