// Ops hub workstream A slice 2: the view-context mechanism. The nav's item
// list flows through navItemsForView so the later Crew My Day and Advertising
// builds add role-filtered nav by extending OPERATOR_VIEWS + the item data,
// not by rewriting OperatorNav.

import { describe, it, expect } from 'vitest';
import { navItemsForView, OPERATOR_VIEWS } from './operatorView';

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

  it('returns no items for the crew and advertising views (not built yet)', () => {
    expect(navItemsForView('crew')).toEqual([]);
    expect(navItemsForView('advertising')).toEqual([]);
  });

  it('marks only the office view as built', () => {
    expect(OPERATOR_VIEWS.filter((v) => v.built).map((v) => v.id)).toEqual(['office']);
  });
});
