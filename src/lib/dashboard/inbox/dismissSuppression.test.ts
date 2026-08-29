// The rule that stops "Not a lead" silencing a paying customer (S75).
//
// Every case below is a real one traced out of prod: three customers silenced
// by someone dismissing the quote tool's own "Quote — $1,799.81" row, one by
// dismissing a GML Media lead forward, one by dismissing a spam SMS that had
// landed on her contact. All five went on to book.

import { describe, it, expect } from 'vitest';
import { shouldSuppressOnDismiss } from './dismissSuppression';

describe('shouldSuppressOnDismiss', () => {
  it('still silences an ordinary repeat sender, which is the whole point', () => {
    expect(shouldSuppressOnDismiss({ source: 'gmail', isKnownCustomer: false })).toEqual({
      suppress: true,
    });
    expect(shouldSuppressOnDismiss({ source: 'ghl', isKnownCustomer: false })).toEqual({
      suppress: true,
    });
  });

  it('never silences anyone off our own quote-sent notification', () => {
    // Gabrielle Moronta, Michael Vahling, Andrew Bykov were all lost this way.
    expect(shouldSuppressOnDismiss({ source: 'quotetool', isKnownCustomer: false })).toEqual({
      suppress: false,
      reason: 'own-notification',
    });
  });

  it('never silences anyone off a Homeworks import either', () => {
    expect(shouldSuppressOnDismiss({ source: 'homeworks', isKnownCustomer: false })).toEqual({
      suppress: false,
      reason: 'own-notification',
    });
  });

  it('never silences a forwarded lead, whose details are the customer’s not the forwarder’s', () => {
    // Susan Pace-Burke was lost this way.
    expect(
      shouldSuppressOnDismiss({ source: 'gmail', isLeadForward: true, isKnownCustomer: false }),
    ).toEqual({ suppress: false, reason: 'lead-forward' });
  });

  it('never silences somebody we have already quoted', () => {
    // Dorinda Novak was lost this way: spam arrived on a real customer's
    // contact, and dismissing the spam silenced her.
    expect(shouldSuppressOnDismiss({ source: 'ghl', isKnownCustomer: true })).toEqual({
      suppress: false,
      reason: 'known-customer',
    });
  });

  it('reports the FIRST reason that applies, so the activity trail is specific', () => {
    expect(
      shouldSuppressOnDismiss({ source: 'quotetool', isLeadForward: true, isKnownCustomer: true }),
    ).toEqual({ suppress: false, reason: 'own-notification' });
  });

  it('treats a missing source as suppressible rather than crashing', () => {
    expect(shouldSuppressOnDismiss({ source: null, isKnownCustomer: false })).toEqual({
      suppress: true,
    });
    expect(shouldSuppressOnDismiss({ source: undefined, isKnownCustomer: false })).toEqual({
      suppress: true,
    });
  });
});
