import { describe, it, expect } from 'vitest';
import { matchLeadForwardPlatform, parseLeadForward } from './leadForward';

// Synthetic fixtures only — never real customer PII in git history (repo
// precedent: a real customer's name was scrubbed from a code comment in S37).
// Shapes mirror the two REAL prod bodies verbatim in structure (verified via
// Supabase against live inbox_items for #268), with fake names/phones/emails.

const DIRECT_BODY =
  'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com Street Address: 42 Fake Lane City: Faketown Areas to light up: Roof Line + Roof Ridges + Trees and Landscaping - (Premium Package) Color Blue';

const REACTION_BODY =
  '🎄 Yule Love Lights Sales reacted via Gmail On Wed, Aug 12, 2026 at 2:46 PM GML Media &lt;no-reply.fake123@zapiermail.com&gt; wrote: Here ya go Naldoven: Pat Sample +15559876543 Email: pat.sample@example.com Street Address: 7 Test Ave City: Sampleville Areas to light up: Roof Line + Roof Ridges - (Standard Package)';

const GML_FROM = { fromAddress: 'no-reply.fake123@zapiermail.com', displayName: 'GML Media' };

describe('matchLeadForwardPlatform', () => {
  it('matches on the known sender domain', () => {
    expect(matchLeadForwardPlatform('no-reply.fake123@zapiermail.com', 'Somebody Else')).not.toBeNull();
  });
  it('matches on the display name alone (address on a different domain)', () => {
    expect(matchLeadForwardPlatform('leads@another-relay.example.com', 'GML Media')).not.toBeNull();
  });
  it('is case-insensitive on the display name', () => {
    expect(matchLeadForwardPlatform('x@other.example.com', 'gml MEDIA')).not.toBeNull();
  });
  it('matches a subdomain of the known sender domain', () => {
    expect(matchLeadForwardPlatform('no-reply@relay.zapiermail.com', null)).not.toBeNull();
  });
  it('does NOT match a lookalike domain that merely starts with the real one', () => {
    expect(matchLeadForwardPlatform('x@notzapiermail.com', null)).toBeNull();
  });
  it('does NOT match a lookalike domain that merely ends with the real one as a suffix without a dot', () => {
    expect(matchLeadForwardPlatform('x@zapiermail.com.evil.co', null)).toBeNull();
  });
  it('does NOT match an unrelated sender', () => {
    expect(matchLeadForwardPlatform('newsletter@example.com', 'Weekly Digest')).toBeNull();
  });
  it('is null-safe on missing sender/name', () => {
    expect(matchLeadForwardPlatform(null, null)).toBeNull();
    expect(matchLeadForwardPlatform(undefined, undefined)).toBeNull();
  });
});

describe('parseLeadForward — direct-forward shape', () => {
  it('parses name, phone, email, street, city', () => {
    const parsed = parseLeadForward({ ...GML_FROM, body: DIRECT_BODY });
    expect(parsed).not.toBeNull();
    expect(parsed?.platformId).toBe('gml-media');
    expect(parsed?.name).toBe('Jamie Test');
    expect(parsed?.phone).toBe('+15551234567');
    expect(parsed?.email).toBe('jamie.test@example.com');
    expect(parsed?.street).toBe('42 Fake Lane');
    expect(parsed?.city).toBe('Faketown');
  });
});

describe('parseLeadForward — reaction-quoted shape (our own Gmail "reacted" re-ingest)', () => {
  it('parses the same fields out of the quoted body', () => {
    const parsed = parseLeadForward({ ...GML_FROM, body: REACTION_BODY });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('Pat Sample');
    expect(parsed?.phone).toBe('+15559876543');
    expect(parsed?.email).toBe('pat.sample@example.com');
    expect(parsed?.street).toBe('7 Test Ave');
    expect(parsed?.city).toBe('Sampleville');
  });
});

describe('parseLeadForward — partial bodies still valid (phone OR email is enough)', () => {
  it('parses with email present but no phone number in the body', () => {
    const body = 'Here ya go Naldoven: Jamie Test Email: jamie.test@example.com Street Address: 42 Fake Lane City: Faketown';
    const parsed = parseLeadForward({ ...GML_FROM, body });
    expect(parsed).not.toBeNull();
    expect(parsed?.phone).toBeNull();
    expect(parsed?.email).toBe('jamie.test@example.com');
  });
  it('parses with phone present but no Email: label in the body', () => {
    const body = 'Here ya go Naldoven: Jamie Test +15551234567 Street Address: 42 Fake Lane City: Faketown';
    const parsed = parseLeadForward({ ...GML_FROM, body });
    expect(parsed).not.toBeNull();
    expect(parsed?.phone).toBe('+15551234567');
    expect(parsed?.email).toBeNull();
    // No "Here ya go...: <name> +1..." adjacency broken by the missing phone
    // lookahead position — name still recoverable since the phone is present.
    expect(parsed?.name).toBe('Jamie Test');
  });
  it('parses with neither street nor city present', () => {
    const body = 'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com';
    const parsed = parseLeadForward({ ...GML_FROM, body });
    expect(parsed).not.toBeNull();
    expect(parsed?.street).toBeNull();
    expect(parsed?.city).toBeNull();
  });
});

describe('parseLeadForward — fail-closed invariant', () => {
  it('returns null when the platform matches but no phone or email is parseable (a receipt/digest, not a lead)', () => {
    const body = 'Thanks for using GML Media! Your monthly statement is attached. Manage your preferences here.';
    expect(parseLeadForward({ ...GML_FROM, body })).toBeNull();
  });
  it('returns null for an unrelated newsletter even when its body happens to mention a phone number', () => {
    const body = 'Call our support line at +15551234567 for help. Reply STOP to opt out.';
    expect(parseLeadForward({ fromAddress: 'weekly@newsletter.example.com', displayName: 'Weekly Digest', body })).toBeNull();
  });
  it('returns null when the platform matches but the body is empty/missing', () => {
    expect(parseLeadForward({ ...GML_FROM, body: null })).toBeNull();
    expect(parseLeadForward({ ...GML_FROM })).toBeNull();
  });
});
