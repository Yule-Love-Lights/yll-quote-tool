import { describe, it, expect } from 'vitest';

import { actionsFor, statusFor403, advertisingBlockedCopy } from './ClockCard';

// The clock card's button state machine, tested without a DOM. The full fetch
// wiring is exercised by the /api/office/clock route tests; this pins the rule
// for WHICH buttons appear, which is the part a person taps.

describe('actionsFor', () => {
  it('offers only Clock in when clocked out', () => {
    const a = actionsFor({ clockedIn: false, onBreak: false });
    expect(a.map((x) => x.action)).toEqual(['in']);
  });

  it('offers Clock out and Start break when clocked in, not on break', () => {
    const a = actionsFor({ clockedIn: true, onBreak: false });
    expect(a.map((x) => x.action)).toEqual(['out', 'break-start']);
  });

  it('swaps Start break for End break while on a break', () => {
    const a = actionsFor({ clockedIn: true, onBreak: true });
    expect(a.map((x) => x.action)).toEqual(['out', 'break-end']);
    // break-start and break-end are never offered together.
    expect(a.some((x) => x.action === 'break-start')).toBe(false);
  });

  it('never offers a break control while clocked out', () => {
    const a = actionsFor({ clockedIn: false, onBreak: false });
    expect(a.some((x) => x.action.startsWith('break'))).toBe(false);
    expect(a.some((x) => x.action === 'out')).toBe(false);
  });
});

// The 403-reason -> card-status mapping, and the copy it renders. Advertising
// role hardening fix round: the adversarial delta-verify caught that
// getOfficeClockCaller's 'is_advertising' reason (added earlier in this same
// PR) had no UI branch — it silently collapsed into 'unlinked', rendering "ask
// an admin to set it up", which is never true for an advertising account.
// There was previously ZERO test coverage of ClockCard's rendering path at
// all (only actionsFor, above); these pin the fix the same way — as pure
// functions, since this repo's vitest setup has no jsdom/DOM environment to
// render the component itself in.
describe('statusFor403', () => {
  it("maps 'inactive' to the inactive status", () => {
    expect(statusFor403('inactive')).toBe('inactive');
  });

  it("maps 'is_advertising' to its OWN status, not the 'unlinked' default", () => {
    // This is the exact regression: before the fix, this returned 'unlinked'.
    expect(statusFor403('is_advertising')).toBe('is_advertising');
  });

  it("defaults everything else (including undefined and the unrelated 'is_crew') to 'unlinked'", () => {
    expect(statusFor403(undefined)).toBe('unlinked');
    expect(statusFor403('unlinked')).toBe('unlinked');
    // is_crew is deliberately left on the default for this fix (see the
    // function's doc comment) -- pinned here so that's a decision, not a gap
    // nobody noticed.
    expect(statusFor403('is_crew')).toBe('unlinked');
  });
});

describe('advertisingBlockedCopy', () => {
  it('renders honest copy — never the "ask an admin to set it up" claim that belongs to the unlinked state', () => {
    const copy = advertisingBlockedCopy();
    expect(copy.headline.toLowerCase()).not.toContain('not linked');
    expect(copy.title.toLowerCase()).not.toContain('ask an admin');
    // The actual claim must be true: advertising accounts structurally don't
    // use this clock at all (not "yet", not "until an admin acts").
    expect(copy.title.toLowerCase()).toContain('advertising');
  });
});
