import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { actionsFor, statusFor403, advertisingBlockedCopy, headerLabel, statusColor, statusShape, markerStyle } from './ClockCard';

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

// The header form of the clock (Naldo, 2026-09-01). It moved out of the
// dashboard and into the nav row, which has about 32px of spare width at
// 1024px, so the trigger says the STATE in a few words and the actions live in
// a dropdown. Both helpers are pure for the same reason actionsFor is: this
// repo has no DOM in its test environment, and the wording is the thing most
// likely to drift.

describe('headerLabel', () => {
  const ready = (over: Partial<{ clockedIn: boolean; onBreak: boolean; shift: { clockInAt: string } | null }>) => ({
    status: 'ready',
    state: { clockedIn: true, onBreak: false, shift: { clockInAt: '2026-09-01T11:22:00Z' }, ...over },
  });

  it('names the shift start when clocked in', () => {
    // Short on purpose: "In 7:22 AM", not "In since 7:22 AM", because the row
    // it sits in was measured and the words cost width.
    expect(headerLabel(ready({}))).toMatch(/^In \d/);
  });

  it('says clocked out, and on break, plainly', () => {
    expect(headerLabel(ready({ clockedIn: false, shift: null }))).toBe('Clocked out');
    expect(headerLabel(ready({ onBreak: true }))).toBe('On break');
  });

  it('falls back to one neutral word before the clock has answered', () => {
    // Never a guess about the state: the trigger must not claim "Clocked out"
    // to someone who is actually clocked in and simply has a slow network.
    expect(headerLabel({ status: 'loading' })).toBe('Clock');
    expect(headerLabel({ status: 'error' })).toBe('Clock');
    expect(headerLabel({ status: 'signedout' })).toBe('Clock');
    expect(headerLabel({ status: 'unlinked' })).toBe('Clock');
  });

  it('handles a clocked-in state with no shift row rather than printing undefined', () => {
    expect(headerLabel(ready({ shift: null }))).toBe('Clocked in');
  });
});

describe('statusColor', () => {
  it('is green on the clock, amber on break, grey otherwise', () => {
    const s = (over: object) => ({ status: 'ready', state: { clockedIn: true, onBreak: false, ...over } });
    expect(statusColor(s({}))).toBe('#16a34a');
    expect(statusColor(s({ onBreak: true }))).toBe('#d97706');
    expect(statusColor(s({ clockedIn: false }))).toBe('var(--op-text-dim)');
  });

  it('shows no colour claim at all until the clock has answered', () => {
    expect(statusColor({ status: 'loading' })).toBe('var(--op-text-dim)');
    expect(statusColor({ status: 'error' })).toBe('var(--op-text-dim)');
  });
});

// Two clocks on one screen (Jason, 2026-09-01). The dashboard card was kept
// alongside the compact header one, so the dashboard shows both at once. They
// each fetch their own state, which is fine until one of them is USED.
describe('the two clocks stay in step', () => {
  const SOURCE = readFileSync(new URL('./ClockCard.tsx', import.meta.url), 'utf8');
  const EVENTS = readFileSync(new URL('./clockEvents.ts', import.meta.url), 'utf8');
  const DASHBOARD = readFileSync(new URL('./DashboardHeader.tsx', import.meta.url), 'utf8');

  it('announces a successful action to the other copy', () => {
    // Without this, clocking out in the header leaves the dashboard card
    // reading "In since 7:22" until the page is reloaded, and a staffer has
    // two controls disagreeing about whether they are on the clock.
    expect(SOURCE).toContain('notifyClockChanged()');
  });

  it('announces only AFTER a success, never on a failed action', () => {
    // The call sits inside the `if (body)` success branch. Announcing on a
    // failure would make the other clock re-read for nothing, and on a 403
    // would hide the blocked state behind a refetch.
    const success = SOURCE.slice(SOURCE.indexOf('if (body) {'));
    expect(success.slice(0, 260)).toContain('notifyClockChanged()');
  });

  it('re-reads the SERVER on the signal rather than copying the payload', () => {
    // This component's existing rule is that it never renders an optimistic
    // guess about what a tap did. A listener that trusted a broadcast payload
    // would break exactly that.
    expect(SOURCE).toContain('window.addEventListener(CLOCK_CHANGED');
    expect(SOURCE).toContain('setReload((n) => n + 1)');
  });

  it('is a no-op on the server, where there is no window', () => {
    expect(EVENTS).toContain("typeof window === 'undefined'");
  });

  it('still renders the dashboard card, which Jason asked to keep', () => {
    expect(DASHBOARD).toContain('<ClockCard />');
  });
});

describe('statusShape', () => {
  const ready = (over: object) => ({ status: 'ready', state: { clockedIn: true, onBreak: false, ...over } });

  it('separates every state by SHAPE, not only by colour', () => {
    // Between 1024 and 1279px the header trigger has no room for words, so the
    // marker is all there is. Green versus amber is unusable to a colour-blind
    // staffer (premerge staff lens), so the shapes must differ too.
    const shapes = [
      statusShape(ready({})),
      statusShape(ready({ onBreak: true })),
      statusShape(ready({ clockedIn: false })),
      statusShape({ status: 'error' }),
    ];
    expect(new Set(shapes).size).toBe(4);
  });

  it('never shows a broken clock as a confirmed clocked-out one', () => {
    // The sharper half of that finding: both rendered the same grey dot, so
    // "the widget failed" and "you are off the clock" looked identical, and
    // they mean opposite things on a payroll control.
    expect(statusShape({ status: 'error' })).not.toBe(statusShape(ready({ clockedIn: false })));
    expect(statusShape({ status: 'signedout' })).toBe('warn');
    expect(statusShape({ status: 'unlinked' })).toBe('warn');
  });

  it('does not warn merely because the clock has not answered yet', () => {
    expect(statusShape({ status: 'loading' })).toBe('hollow');
  });
});

describe('markerStyle', () => {
  // The shape NAMES were already distinct and the render still collapsed two
  // of them: 'ring' and 'hollow' both drew a transparent circle with the same
  // border, so on-break and clocked-out differed by COLOUR alone, which is the
  // finding this was meant to fix. The helper's test passed; a browser check
  // caught it. So the assertion is now on what gets drawn.
  it('draws every state differently WITHOUT relying on colour', () => {
    const grey = 'var(--op-text-dim)';
    const drawn = [
      markerStyle('filled', '#16a34a'),
      markerStyle('ring', '#d97706'),
      markerStyle('hollow', grey),
    ];
    // Compare geometry only: same colour for all three, so any difference that
    // survives is a difference a colour-blind reader can still see.
    const shapesOnly = drawn.map((d) => ({
      filled: d.background !== 'transparent',
      radius: d.borderRadius,
      outlined: d.border !== 'none',
    }));
    expect(new Set(shapesOnly.map((s) => JSON.stringify(s))).size).toBe(3);
  });

  it('does not draw on-break as the clocked-out marker in another colour', () => {
    const same = 'red';
    expect(markerStyle('ring', same)).not.toEqual(markerStyle('hollow', same));
  });

  it('draws the clocked-in marker solid and round', () => {
    const m = markerStyle('filled', '#16a34a');
    expect(m.background).toBe('#16a34a');
    expect(m.borderRadius).toBe('9999px');
  });
});

describe('a failed re-read keeps the state it already had', () => {
  const SOURCE = readFileSync(new URL('./ClockCard.tsx', import.meta.url), 'utf8');

  it('only falls to the error state when there is nothing better to show', () => {
    // Two clocks re-read each other's actions, so a single network blip on the
    // refresh used to leave one saying "Time clock unavailable" beside another
    // showing the live shift: two controls disagreeing, which is worse than
    // either alone (premerge staff lens).
    expect(SOURCE).toContain('const failSoftly');
    expect(SOURCE).toContain("setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }))");
    // And nothing sets the error state the blunt way any more.
    expect(SOURCE).not.toContain("setLoad({ status: 'error' })");
  });
});
