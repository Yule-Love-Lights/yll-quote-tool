import { describe, it, expect } from 'vitest';
import { normalizeGhlConversation } from './ghl';
import type { GhlConversation } from './ghl';

// #252: normalizeGhlConversation always returns a touch (never null) — kept
// as a thin passthrough so the normal-conversation assertions below read the
// same as before the #252 fix (it used to unwrap a nullable activity-noise
// return; same pattern as quotetool.test.ts's mustTouch, #181).
function mustTouch(t: ReturnType<typeof normalizeGhlConversation>) {
  return t;
}

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
    const t = mustTouch(normalizeGhlConversation(conversation()));
    expect(t.source).toBe('ghl');
    expect(t.externalId).toBe('iuNLqFmTCIRAGCsoXcYw');
    expect(t.direction).toBe('inbound');
    expect(t.lastMessageAt.getTime()).toBe(1782693272654); // epoch-ms parsed
    expect(t.preview).toBe('How would you like the balance paid?');
  });

  it('maps lastMessageType to a channel', () => {
    expect(mustTouch(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_SMS' }))).channel).toBe('sms');
    expect(mustTouch(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_EMAIL' }))).channel).toBe('email');
    expect(mustTouch(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_FACEBOOK' }))).channel).toBe('fb');
    expect(mustTouch(normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_INSTAGRAM' }))).channel).toBe('ig');
  });

  it('synthesizes a preview for a call (no body)', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_CALL', lastMessageBody: '', lastMessageDirection: 'inbound' }),
    ));
    expect(t.channel).toBe('call');
    expect(t.preview).toBe('📞 Inbound call');
  });

  // #252: live 4-call sweep (2026-08-12) — an INBOUND call (answered, or
  // answered-with-voicemail) reports as TYPE_IVR_CALL, not TYPE_CALL/
  // TYPE_VOICEMAIL. Before this it fell through to channel: null and
  // previewOf produced no "📞 Inbound call" text at all.
  it('maps an inbound TYPE_IVR_CALL to the call channel with a synthesized preview', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_IVR_CALL', lastMessageBody: '', lastMessageDirection: 'inbound' }),
    ));
    expect(t.channel).toBe('call');
    expect(t.direction).toBe('inbound');
    expect(t.preview).toBe('📞 Inbound call');
  });

  it('builds the contact identity (ghl id + normalized email/phone + name)', () => {
    const t = mustTouch(normalizeGhlConversation(conversation()));
    expect(t.identity.ghlContactId).toBe('edezNh2PRTcox92ub2bL');
    expect(t.identity.emails).toEqual(['cristina@example.com']);
    expect(t.identity.phones).toEqual(['+16315552223']); // E.164 normalized
    expect(t.identity.displayName).toBe('Cristina Foss');
  });

  it('omits missing email/phone rather than emitting empty strings', () => {
    const t = mustTouch(normalizeGhlConversation(conversation({ email: undefined, phone: undefined })));
    expect(t.identity.emails).toEqual([]);
    expect(t.identity.phones).toEqual([]);
  });

  it('passes an outbound direction through (drives auto-resolve downstream)', () => {
    const t = mustTouch(normalizeGhlConversation(conversation({ lastMessageDirection: 'outbound' })));
    expect(t.direction).toBe('outbound');
  });

  it('keeps the raw payload for audit', () => {
    const raw = conversation();
    expect(mustTouch(normalizeGhlConversation(raw)).raw).toBe(raw);
  });

  it('classifies automated when preview contains "Reply STOP to opt out"', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageBody: 'Thanks for contacting us. Reply STOP to opt out of messages.' }),
    ));
    expect(t.leadKind).toBe('automated');
  });

  it('classifies a normal conversation as a lead', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageBody: 'How much does it cost to put up lights on my house?' }),
    ));
    expect(t.leadKind).toBe('lead');
  });
});

// #252: pure GHL system/CRM activity ("Opportunity created", "DnD enabled by
// user") is FLAGGED (isActivityNoise), never excluded at this layer — an
// unconditional null-return here used to be able to swallow a conversation's
// FIRST-EVER touch forever (searchConversations only ever hands the poller
// the single most-recent event; see ghl.ts's ACTIVITY_NOISE_TYPES comment).
// store.ts's planIngest decides whether to skip, based on whether a row
// already exists — see store.test.ts's "GHL activity-noise touch" describe.
describe('normalizeGhlConversation — GHL activity noise is flagged, not excluded (#252)', () => {
  // Pre-#252-fix, normalizeGhlConversation returned null unconditionally for
  // these types — this assertion is the one that would fail against that
  // implementation (a null touch here means sync.ts never even calls
  // ingestTouch, so a brand-new lead with no existing row is swallowed).
  it('still produces a touch for a TYPE_ACTIVITY_CONTACT conversation (never swallowed)', () => {
    const t = normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_ACTIVITY_CONTACT' }));
    expect(t).not.toBeNull();
    expect(t.isActivityNoise).toBe(true);
    expect(t.source).toBe('ghl');
    expect(t.externalId).toBe('iuNLqFmTCIRAGCsoXcYw');
  });

  it('still produces a touch for a TYPE_ACTIVITY_OPPORTUNITY conversation (never swallowed)', () => {
    const t = normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_ACTIVITY_OPPORTUNITY' }));
    expect(t).not.toBeNull();
    expect(t.isActivityNoise).toBe(true);
  });

  it('does not flag a real SMS conversation as activity noise (the regression guard that matters)', () => {
    const t = normalizeGhlConversation(conversation({ lastMessageType: 'TYPE_SMS' }));
    expect(t.isActivityNoise).toBe(false);
  });
});

// #252: TYPE_NO_SHOW is GHL logging a missed booked appointment, not a
// customer message. It carries no body and isn't in CHANNEL_BY_TYPE (not a
// real communication channel), so it must be forced 'automated' here or it
// counts as an unanswered lead and can escalate (a real prod row hit
// escalation_level 2/RED this way — see ledger #252).
describe('normalizeGhlConversation — TYPE_NO_SHOW is automated, not a lead (#252)', () => {
  it('classifies a no-show as automated', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_NO_SHOW', lastMessageBody: '' }),
    ));
    expect(t.leadKind).toBe('automated');
  });

  it('leaves channel null for a no-show (not a real communication channel)', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_NO_SHOW', lastMessageBody: '' }),
    ));
    expect(t.channel).toBeNull();
  });

  it('synthesizes a "missed appointment" preview for a no-show so the row is never blank', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_NO_SHOW', lastMessageBody: '' }),
    ));
    expect(t.preview).toBe('🚫 No-show (missed appointment)');
  });

  // Regression guard: the bug this fixes must not spread — a real customer
  // touch on the SAME channel-agnostic path (no body, e.g. an inbound call)
  // still classifies as a lead.
  it('does not affect a real customer touch (a call with no body still classifies as a lead)', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_CALL', lastMessageBody: '', lastMessageDirection: 'inbound' }),
    ));
    expect(t.leadKind).toBe('lead');
  });

  it('does not affect a normal SMS conversation (still classifies as a lead)', () => {
    const t = mustTouch(normalizeGhlConversation(
      conversation({ lastMessageType: 'TYPE_SMS', lastMessageBody: 'Can you come out Tuesday?' }),
    ));
    expect(t.leadKind).toBe('lead');
  });
});

describe('normalizeGhlConversation — sender-suppression set (layer 3)', () => {
  it('classifies as automated when the normalized email is in the suppressed set', () => {
    // normalizeEmail('cristina@example.com') → 'cristina@example.com'
    const t = mustTouch(normalizeGhlConversation(conversation(), new Set(['cristina@example.com'])));
    expect(t.leadKind).toBe('automated');
  });

  it('classifies as automated when the normalized phone is in the suppressed set', () => {
    // normalizePhone('(631) 555-2223') → '+16315552223'
    const t = mustTouch(normalizeGhlConversation(conversation(), new Set(['+16315552223'])));
    expect(t.leadKind).toBe('automated');
  });

  it('classifies as lead when neither email nor phone is in the suppressed set', () => {
    const t = mustTouch(normalizeGhlConversation(conversation(), new Set(['other@example.com'])));
    expect(t.leadKind).toBe('lead');
  });

  it('classifies normally when suppressed set is undefined', () => {
    const t = mustTouch(normalizeGhlConversation(conversation()));
    expect(t.leadKind).toBe('lead');
  });

  it('classifies normally when suppressed set is empty', () => {
    const t = mustTouch(normalizeGhlConversation(conversation(), new Set()));
    expect(t.leadKind).toBe('lead');
  });
});
