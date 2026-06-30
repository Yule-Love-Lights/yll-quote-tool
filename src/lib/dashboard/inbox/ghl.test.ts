import { describe, it, expect } from 'vitest';
import { normalizeGhlConversation } from './ghl';
import type { GhlConversation } from './ghl';

// Shaped from the real /conversations/search payload the spike returned
// (PII swapped for fakes). Timestamps are epoch-ms per the spike finding.
function conversation(over: Partial<GhlConversation> = {}): GhlConversation {
  return {
    id: 'iuNLqFmTCIRAGCsoXcYw',
    locationId: 'zHpH8HA5xfa7magbxtvU',
    lastMessageDate: 1782693272654,
    lastMessageType: 'TYPE_SMS',
    lastMessageBody: 'How would you like the balance paid?',
    lastMessageDirection: 'inbound',
    unreadCount: 1,
    contactId: 'edezNh2PRTcox92ub2bL',
    fullName: 'Cristina Foss',
    contactName: 'Cristina Foss',
    email: 'cristina@example.com',
    phone: '(631) 555-2223',
    type: 'TYPE_PHONE',
    ...over,
  };
}

describe('normalizeGhlConversation — maps a raw GHL conversation to a NormalizedTouch', () => {
  it('extracts the core fields (source, external id, direction, timestamp, preview)', () => {
    const t = normalizeGhlConversation(conversation());
    expect(t.source).toBe('ghl');
    expect(t.externalId).toBe('iuNLqFmTCIRAGCsoXcYw');
    expect(t.direction).toBe('inbound');
    expect(t.lastMessageAt.getTime()).toBe(1782693272654); // epoch-ms parsed
    expect(t.preview).toBe('How would you like the balance paid?');
  });

  it('maps lastMessageType to a channel', () => {
    expect(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_SMS' })).channel).toBe('sms');
    expect(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_EMAIL' })).channel).toBe('email');
    expect(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_FACEBOOK' })).channel).toBe('fb');
    expect(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_INSTAGRAM' })).channel).toBe('ig');
  });

  it('synthesizes a preview for a call (no body)', () => {
    const t = normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_CALL', lastMessageBody: '', lastMessageDirection: 'inbound' }),
    );
    expect(t.channel).toBe('call');
    expect(t.preview).toBe('📞 Inbound call');
  });

  it('builds the contact identity (ghl id + normalized email/phone + name)', () => {
    const t = normalizeGhlConversation(conversation());
    expect(t.identity.ghlContactId).toBe('edezNh2PRTcox92ub2bL');
    expect(t.identity.emails).toEqual(['cristina@example.com']);
    expect(t.identity.phones).toEqual(['+16315552223']); // E.164 normalized
    expect(t.identity.displayName).toBe('Cristina Foss');
  });

  it('omits missing email/phone rather than emitting empty strings', () => {
    const t = normalizeGhlConversation(conversation({ email: undefined, phone: undefined }));
    expect(t.identity.emails).toEqual([]);
    expect(t.identity.phones).toEqual([]);
  });

  it('passes an outbound direction through (drives auto-resolve downstream)', () => {
    const t = normalizeGhlConversation(conversation({ lastMessageDirection: 'outbound' }));
    expect(t.direction).toBe('outbound');
  });

  it('keeps the raw payload for audit', () => {
    const raw = conversation();
    expect(normalizeGhlConversation(raw).raw).toBe(raw);
  });

  it('classifies automated when preview contains "Reply STOP to opt out"', () => {
    const t = normalizeGhlConversation(
      conversation({ lastMessageBody: 'Thanks for contacting us. Reply STOP to opt out of messages.' }),
    );
    expect(t.leadKind).toBe('automated');
  });

  it('classifies a normal conversation as a lead', () => {
    const t = normalizeGhlConversation(
      conversation({ lastMessageBody: 'How much does it cost to put up lights on my house?' }),
    );
    expect(t.leadKind).toBe('lead');
  });
});
