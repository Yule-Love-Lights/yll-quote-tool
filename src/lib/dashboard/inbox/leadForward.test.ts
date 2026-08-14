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

describe('matchLeadForwardPlatform — requires BOTH domain AND display name (#268 fix round, technical HIGH)', () => {
  it('matches when both the domain and display name are correct', () => {
    expect(matchLeadForwardPlatform('no-reply.fake123@zapiermail.com', 'GML Media')).not.toBeNull();
  });
  it('is case-insensitive on the display name (both legs still correct)', () => {
    expect(matchLeadForwardPlatform('no-reply.fake123@zapiermail.com', 'gml MEDIA')).not.toBeNull();
  });
  it('matches a subdomain of the known sender domain (with the correct display name)', () => {
    expect(matchLeadForwardPlatform('no-reply@relay.zapiermail.com', 'GML Media')).not.toBeNull();
  });

  // Attack shapes (#268 fix round): each leg alone is forgeable —
  // zapiermail.com is Zapier's shared multi-tenant relay (any free Zapier
  // account can send from it) and the display name is attacker-chosen free
  // text on most sending paths — so neither may single-handedly authorize
  // the override.
  it('right DOMAIN, wrong display name → no match (the known domain alone is not enough)', () => {
    expect(matchLeadForwardPlatform('no-reply.fake123@zapiermail.com', 'Somebody Else')).toBeNull();
  });
  it('right DISPLAY NAME, wrong domain → no match (a spoofed display name alone is not enough)', () => {
    expect(matchLeadForwardPlatform('leads@another-relay.example.com', 'GML Media')).toBeNull();
  });
  it('right display name, missing domain (no @) → no match', () => {
    expect(matchLeadForwardPlatform('not-an-email', 'GML Media')).toBeNull();
  });
  it('right domain, missing display name → no match', () => {
    expect(matchLeadForwardPlatform('no-reply@relay.zapiermail.com', null)).toBeNull();
  });

  it('does NOT match a lookalike domain that merely starts with the real one, even with the correct display name', () => {
    expect(matchLeadForwardPlatform('x@notzapiermail.com', 'GML Media')).toBeNull();
  });
  it('does NOT match a lookalike domain that merely ends with the real one as a suffix without a dot, even with the correct display name', () => {
    expect(matchLeadForwardPlatform('x@zapiermail.com.evil.co', 'GML Media')).toBeNull();
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

describe('parseLeadForward — template-scoped extraction (#268 fix round, technical HIGH)', () => {
  it('does NOT pick up a phone number in a footer/signature when there is no "Here ya go" template at all (fail closed)', () => {
    const body = 'GML Media respects your privacy. Questions about your account? Call our office at +15551234567 any time.';
    expect(parseLeadForward({ ...GML_FROM, body })).toBeNull();
  });

  it('ignores a real customer phone/email planted BEFORE the "Here ya go" marker', () => {
    // A phone+email pair sitting in front of the template must never become
    // the parsed identity — only content from "Here ya go" onward counts.
    const body =
      'Call our existing customer back at +19995551111, email old-lead@example.com. ' +
      'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com';
    const parsed = parseLeadForward({ ...GML_FROM, body });
    expect(parsed).not.toBeNull();
    expect(parsed?.phone).toBe('+15551234567');
    expect(parsed?.email).toBe('jamie.test@example.com');
  });

  it('ignores a second phone/email appended AFTER "Areas to light up:" (a footer/signature) — the template block has its own values, and only those are used', () => {
    const body = `${DIRECT_BODY} Questions? Call our office at +19995551234 or email accounting@example.com.`;
    const parsed = parseLeadForward({ ...GML_FROM, body });
    expect(parsed).not.toBeNull();
    // Still the TEMPLATE's own phone/email, never the footer's.
    expect(parsed?.phone).toBe('+15551234567');
    expect(parsed?.email).toBe('jamie.test@example.com');
  });

  it('fails closed when the template block itself has no phone/email, even though a footer AFTER it does', () => {
    const body =
      'Here ya go Naldoven: Jamie Test Street Address: 42 Fake Lane City: Faketown ' +
      'Areas to light up: Roof Line - (Standard) ' +
      'Questions? Call our office at +19995551234 or email accounting@example.com.';
    expect(parseLeadForward({ ...GML_FROM, body })).toBeNull();
  });

  it('RESIDUAL, ACCEPTED RISK: a fully-forged template with BOTH platform legs spoofed still parses — documented, not fixed here (see leadForward.ts top-of-file note)', () => {
    const forgedBody = 'Here ya go Naldoven: Jamie Test +15551234567 Email: attacker@evil.example.com';
    const parsed = parseLeadForward({ ...GML_FROM, body: forgedBody });
    expect(parsed).not.toBeNull();
    expect(parsed?.email).toBe('attacker@evil.example.com');
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
