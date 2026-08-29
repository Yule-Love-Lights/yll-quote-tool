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
      'Customers',
      'Quotes',
      'Jobs',
      'Schedule',
      'Fleet',
      'Invoices',
      'Tasks',
      'Inventory',
      'Insights',
      'Settings',
    ]);
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
      ['Review', '/admin/advertising'],
      ['Pay', '/admin/advertising/pay'],
      ['People', '/admin/advertising/crew'],
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
    for (const area of ['home', 'inbox', 'quotes', 'jobs', 'fleet', 'invoices', 'settings', 'time', 'leads'] as const) {
      expect(viewForArea(area)).toBe('office');
    }
  });
});
