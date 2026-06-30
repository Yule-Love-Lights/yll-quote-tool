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
