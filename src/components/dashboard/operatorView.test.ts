// Ops hub workstream A slice 2: the view-context mechanism. The nav's item
// list flows through navItemsForView so the later Crew My Day and Advertising
// builds add role-filtered nav by extending OPERATOR_VIEWS + the item data,
// not by rewriting OperatorNav.

import { describe, it, expect } from 'vitest';
import { navItemsForView, OPERATOR_VIEWS, viewForArea } from './operatorView';

describe('navItemsForView', () => {
  it('returns the full current nav list, in order, for the office view', () => {
    const labels = navItemsForView('office').map((i) => i.label);
    expect(labels).toEqual([
      'Home',
      'Inbox',
      'Tasks',
      'Quotes',
      'Jobs',
      'Schedule',
      'Invoices',
      'Inventory',
    ]);
  });

  // Naldo, 2026-08-31. Each of these four left the bar for a different reason
  // and NONE of them was deleted, so this pins the list against a future
  // "restore" that would quietly undo the decision.
  it('keeps Customers, Fleet, Insights and Settings out of the bar', () => {
    const labels = navItemsForView('office').map((i) => i.label);
    // Customers: the header search box is the faster way in.
    // Fleet: it is the Schedule page's right column now.
    // Insights and Settings: they live in the account menu.
    for (const gone of ['Customers', 'Fleet', 'Insights', 'Settings']) {
      expect(labels).not.toContain(gone);
    }
  });

  it('gives Schedule its own area so Jobs cannot light up beside it', () => {
    const items = navItemsForView('office');
    const jobs = items.find((i) => i.label === 'Jobs');
    const schedule = items.find((i) => i.label === 'Schedule');
    expect(jobs?.match).toEqual(['jobs']);
    expect(schedule?.match).toEqual(['schedule']);
    // The real defect this fixes: Schedule used to declare match: ['jobs'],
    // so visiting it highlighted two tabs at once.
    expect(schedule?.match).not.toContain('jobs');
  });

  it('never lets two office items claim the same area', () => {
    const seen = new Map<string, string>();
    for (const item of navItemsForView('office')) {
      for (const area of item.match) {
        expect(seen.has(area)).toBe(false);
        seen.set(area, item.label);
      }
    }
  });

  it('gives every office item a real href and at least one match area', () => {
    for (const item of navItemsForView('office')) {
      expect(item.href.startsWith('/')).toBe(true);
      expect(item.match.length).toBeGreaterThan(0);
    }
  });

  it('returns the admin advertising surfaces for the advertising view, in order', () => {
    // Wired when #1061's surfaces landed: the worker home stays out (an admin
    // is redirected off /advertising by that page's own design; the admin
    // side lives under /admin/advertising).
    const items = navItemsForView('advertising');
    expect(items.map((i) => [i.label, i.href])).toEqual([
      ['Campaigns', '/admin/advertising'],
      ['Settings & pay', '/admin/advertising/settings'],
      ['Crew', '/admin/advertising/crew'],
    ]);
    // Each item highlights alone (the Jobs-and-Fleet-lighting-together class
    // is a bug by Naldo's 2026-08-28 ruling, not an accepted cost).
    const areas = items.map((i) => i.match);
    expect(areas).toEqual([['advertising'], ['advertising-pay'], ['advertising-people']]);
  });

  it('returns no items for the crew view (not built yet)', () => {
    expect(navItemsForView('crew')).toEqual([]);
  });

  it('marks office and advertising as built, crew not', () => {
    expect(OPERATOR_VIEWS.filter((v) => v.built).map((v) => v.id)).toEqual(['office', 'advertising']);
  });
});

describe('viewForArea', () => {
  it('maps the three advertising areas to the advertising view', () => {
    expect(viewForArea('advertising')).toBe('advertising');
    expect(viewForArea('advertising-pay')).toBe('advertising');
    expect(viewForArea('advertising-people')).toBe('advertising');
  });

  it('maps every office area to office (positive list, nothing leaks)', () => {
    for (const area of ['home', 'inbox', 'quotes', 'jobs', 'schedule', 'fleet', 'invoices', 'settings', 'insights', 'customers', 'time', 'leads'] as const) {
      expect(viewForArea(area)).toBe('office');
    }
  });
});
