import { describe, it, expect } from 'vitest';
import { classifyMessage, isFromUs } from './classify';

describe('isFromUs', () => {
  const opts = { ourDomain: 'yulelovelights.com', internalAddrs: ['sales@yulelovelights.com'] };
  it('matches our domain', () => {
    expect(isFromUs('anyone@yulelovelights.com', opts)).toBe(true);
  });
  it('matches an explicit internal address regardless of domain', () => {
    expect(isFromUs('sales@yulelovelights.com', opts)).toBe(true);
  });
  it('rejects an outside address', () => {
    expect(isFromUs('customer@gmail.com', opts)).toBe(false);
  });
  it('is null-safe', () => {
    expect(isFromUs(null, opts)).toBe(false);
  });
});

// #252: our own automated mail (marketing sends, "Quote viewed" alerts, the
// escalation email, the EOD digest) goes out from sales@mail.yulelovelights.com
// — a SUBDOMAIN. 152 of these self-ingested as fake leads over 14 days because
// the old check was exact-domain-only.
describe('isFromUs — subdomain-aware internal domain matching (#252)', () => {
  it('matches a subdomain of ourDomain (the live sales@mail.yulelovelights.com shape)', () => {
    expect(isFromUs('sales@mail.yulelovelights.com', { ourDomain: 'yulelovelights.com' })).toBe(true);
  });

  it('matches the bare domain with no explicit ourDomain passed (falls back to the static internal list)', () => {
    expect(isFromUs('someone@yulelovelights.com', {})).toBe(true);
  });

  it('matches a subdomain with no explicit ourDomain passed (falls back to the static internal list)', () => {
    expect(isFromUs('sales@mail.yulelovelights.com', {})).toBe(true);
  });

  it('matches a subdomain with opts entirely omitted (GMAIL_USER-unset shape — no domain source at all)', () => {
    expect(isFromUs('sales@mail.yulelovelights.com')).toBe(true);
  });

  it('does NOT match a lookalike domain that merely starts with ours (notyulelovelights.com)', () => {
    expect(isFromUs('anyone@notyulelovelights.com', { ourDomain: 'yulelovelights.com' })).toBe(false);
  });

  it('does NOT match a lookalike domain that merely ends with ours as a suffix without a dot (yulelovelights.com.evil.co)', () => {
    expect(isFromUs('anyone@yulelovelights.com.evil.co', { ourDomain: 'yulelovelights.com' })).toBe(false);
  });

  it('still rejects a real customer address on an unrelated domain', () => {
    expect(isFromUs('jane@gmail.com', { ourDomain: 'yulelovelights.com' })).toBe(false);
  });

  // #252 LOW: a trailing-dot FQDN (technically valid, e.g. an address a mail
  // client normalized) must still match our subdomain, not slip past the
  // self-ingest filter. Not reachable via real Gmail/GHL payloads today.
  it('matches a subdomain with a trailing dot (a technically-valid FQDN)', () => {
    expect(isFromUs('sales@mail.yulelovelights.com.', { ourDomain: 'yulelovelights.com' })).toBe(true);
  });
});

describe('classifyMessage', () => {
  it('flags a List-Unsubscribe message as automated', () => {
    expect(classifyMessage({ fromAddress: 'news@getjobber.com', subject: 'Last day', preview: 'Grab a $499 ticket', hasListUnsubscribe: true })).toBe('automated');
  });
  it('flags a no-reply sender as automated', () => {
    expect(classifyMessage({ fromAddress: 'no-reply@notify.example.com', subject: 'Receipt', preview: 'x' })).toBe('automated');
  });
  it('flags unsubscribe language in the preview as automated', () => {
    expect(classifyMessage({ fromAddress: 'info@vendor.com', subject: 'Hi', preview: "you just called us... If you no longer wish to receive these emails" })).toBe('automated');
  });
  it('flags SMS opt-out language as automated', () => {
    expect(classifyMessage({ fromAddress: null, subject: null, preview: 'Sale ends today! Reply STOP to opt out' })).toBe('automated');
  });
  it('treats a normal customer message as a lead', () => {
    expect(classifyMessage({ fromAddress: 'jane@gmail.com', subject: 'Quote question', preview: 'How much for my roofline?' })).toBe('lead');
  });
});
