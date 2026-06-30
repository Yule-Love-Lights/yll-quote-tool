import { describe, it, expect } from 'vitest';
import { resolveReplyTarget } from './reply';

describe('resolveReplyTarget', () => {
  it('routes a GHL sms item to sendSms with the contact id', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'sms', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c1' });
  });
  it('routes a GHL email item to sendEmail', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'email', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'email', contactId: 'c1' });
  });
  it('defaults a GHL call/unknown channel to sms', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'call', ghlContactId: 'c1' }))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c1' });
  });
  it('routes a quote lead to email by default, honoring an explicit channel choice', () => {
    expect(resolveReplyTarget({ source: 'quotetool', channel: 'app', ghlContactId: 'c9' }))
      .toEqual({ kind: 'send', via: 'email', contactId: 'c9' });
    expect(resolveReplyTarget({ source: 'quotetool', channel: 'app', ghlContactId: 'c9' }, 'sms'))
      .toEqual({ kind: 'send', via: 'sms', contactId: 'c9' });
  });
  it('refuses gmail (no inline send in v2)', () => {
    expect(resolveReplyTarget({ source: 'gmail', channel: 'email', ghlContactId: null }).kind).toBe('unsupported');
  });
  it('flags a missing GHL contact id', () => {
    expect(resolveReplyTarget({ source: 'ghl', channel: 'sms', ghlContactId: null }).kind).toBe('no_contact');
  });
});
