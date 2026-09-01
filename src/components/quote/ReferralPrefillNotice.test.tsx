// The referral prefill prompt: the pure card's copy, plus the two decisions
// that decide whether it ever appears.
//
// What matters most is that it stays SILENT in the states where showing it
// would be wrong. A notice that cries wolf gets ignored, and this is the only
// thing standing between a referrer and their $125.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralPrefillCard } from './ReferralPrefillNotice';
import {
  shouldLookupReferral,
  lookupPendingReferral,
  referrerLabel,
  type PendingReferralMatch,
} from '@/lib/referralPrefillClient';

const MATCH: PendingReferralMatch = {
  referralId: 'r1',
  referrerCustomerId: 'c-referrer',
  referrerName: 'Dana Whitfield',
  refereeName: 'Sam Friend',
  createdAt: '2026-03-10T10:00:00Z',
  matchedOn: 'phone',
};

const noop = () => {};

describe('ReferralPrefillCard (the copy)', () => {
  it('names the referrer and how they were matched', () => {
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={MATCH} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('This lead came from a referral link.');
    expect(html).toContain('Dana Whitfield sent');
    expect(html).toContain('phone number');
    expect(html).toContain('Set Dana Whitfield as the referrer');
  });

  it('says out loud that a missed referral cannot be fixed later', () => {
    // This sentence is the entire reason the prompt exists, so it is pinned.
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={MATCH} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('cannot be added afterwards');
  });

  it('says "email" when that is what matched, not always "phone number"', () => {
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={{ ...MATCH, matchedOn: 'email' }} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('the email matches');
    expect(html).not.toContain('phone number');
  });

  it('reads naturally when the referrer row has no name on file', () => {
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={{ ...MATCH, referrerName: null }} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('Another customer sent');
  });

  it('never uses an em dash (voice rules)', () => {
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={MATCH} onUse={noop} onDismiss={noop} />,
    );
    expect(html).not.toContain('—');
  });
});

describe('referrerLabel', () => {
  it('falls back when the name is null, empty or whitespace', () => {
    expect(referrerLabel(MATCH)).toBe('Dana Whitfield');
    expect(referrerLabel({ ...MATCH, referrerName: null })).toBe('Another customer');
    expect(referrerLabel({ ...MATCH, referrerName: '   ' })).toBe('Another customer');
  });
});

describe('shouldLookupReferral (when to stay silent)', () => {
  it('does not ask before any contact details are typed', () => {
    expect(shouldLookupReferral({ phone: '', email: '', alreadySet: false })).toBe(false);
    expect(shouldLookupReferral({ phone: '   ', email: '  ', alreadySet: false })).toBe(false);
  });

  it('does not ask once a referrer is already set, even with a phone on file', () => {
    expect(shouldLookupReferral({ phone: '5165550123', email: '', alreadySet: true })).toBe(false);
  });

  it('asks on either a phone or an email alone', () => {
    expect(shouldLookupReferral({ phone: '5165550123', email: '', alreadySet: false })).toBe(true);
    expect(shouldLookupReferral({ phone: '', email: 'sam@example.com', alreadySet: false })).toBe(true);
  });
});

describe('lookupPendingReferral (how it asks)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the lead details in the POST body, never in the URL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ match: MATCH }) });
    await lookupPendingReferral({
      phone: ' 5165550123 ',
      email: ' sam@example.com ',
      excludeCustomerId: 'c-self',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/referrals/pending-lookup');
    expect(String(url)).not.toContain('5165550123');
    expect(String(url)).not.toContain('sam@example.com');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      phone: '5165550123',
      email: 'sam@example.com',
      excludeCustomerId: 'c-self',
    });
  });

  it('returns the match when the lead did come from a link', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ match: MATCH }) });
    await expect(lookupPendingReferral({ phone: '5165550123', email: '' })).resolves.toEqual(MATCH);
  });

  it('returns null when the lead did not come from a link', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ match: null }) });
    await expect(lookupPendingReferral({ phone: '5169999999', email: '' })).resolves.toBeNull();
  });

  it('returns null on a non-ok response rather than surfacing an error', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    await expect(lookupPendingReferral({ phone: '5165550123', email: '' })).resolves.toBeNull();
  });

  it('returns null when the network throws: a hiccup must not break the builder', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(lookupPendingReferral({ phone: '5165550123', email: '' })).resolves.toBeNull();
  });
});


describe('ReferralPrefillCard: naming the referred friend', () => {
  it('names the friend, so staff can catch a shared-household phone match', () => {
    // Without this, a household or shared office number could attribute $125
    // to the wrong person with nothing on screen to catch it.
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={MATCH} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('Sam Friend');
  });

  it('still reads as a sentence when the referral has no friend name on file', () => {
    const html = renderToStaticMarkup(
      <ReferralPrefillCard match={{ ...MATCH, refereeName: null }} onUse={noop} onDismiss={noop} />,
    );
    expect(html).toContain('sent them');
    expect(html).not.toContain('sent , and');
  });
});
