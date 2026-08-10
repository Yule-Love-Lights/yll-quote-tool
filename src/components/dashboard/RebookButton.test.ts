import { describe, it, expect } from 'vitest';
import { decideRebookClick, type RebookProperty } from './RebookButton';

// WT-53: RebookButton must never let a click clone a system-wide "most
// recently approved" guess when a customer has more than one property.
// decideRebookClick is the pure click-routing logic (extracted so it's
// testable without a DOM/jsdom, which this repo's test setup doesn't run).
// It decides whether a click should post immediately (0 or 1 property) or
// open the property picker first (2+ properties).

const propA: RebookProperty = { id: 'prop-a', address: '123 Main St' };
const propB: RebookProperty = { id: 'prop-b', address: '456 Oak Ave' };

describe('decideRebookClick', () => {
  it('posts with no propertyId when the customer has zero properties (pre-backfill)', () => {
    expect(decideRebookClick([])).toEqual({ kind: 'post', propertyId: undefined });
  });

  it('posts scoped to the single property when exactly one exists (no picker needed)', () => {
    expect(decideRebookClick([propA])).toEqual({ kind: 'post', propertyId: 'prop-a' });
  });

  it('opens the picker instead of posting when 2+ properties exist', () => {
    expect(decideRebookClick([propA, propB])).toEqual({ kind: 'pick' });
  });

  it('opens the picker for 3+ properties too', () => {
    const propC: RebookProperty = { id: 'prop-c', address: null };
    expect(decideRebookClick([propA, propB, propC])).toEqual({ kind: 'pick' });
  });

  // #205 review fix (customer/staff HIGH, F1): archived-ness must NEVER
  // shrink the population this decides ambiguity from — the caller passes
  // ALL properties (archived included; see this file's RebookProperty/
  // decideRebookClick comments), so these prove the pure logic handles that
  // correctly. Before the fix, the CALLER (page.tsx) pre-filtered archived
  // properties out, so a live property with zero approved-quote history
  // could look "unambiguous" (count=1) while the real source sat archived
  // and hidden — the click posted against the wrong property and 404'd.
  describe('archived properties count toward ambiguity, not away from it (#205 F1)', () => {
    it('opens the picker when a live property coexists with an archived one — archived-ness does not shrink the population', () => {
      const archived: RebookProperty = { id: 'prop-old', address: '9 Prior Rd', archivedAt: '2026-01-01T00:00:00Z' };
      expect(decideRebookClick([propA, archived])).toEqual({ kind: 'pick' });
    });

    it('posts directly when the customer has exactly ONE property, even if it is archived', () => {
      const onlyArchived: RebookProperty = { id: 'prop-old', address: '9 Prior Rd', archivedAt: '2026-01-01T00:00:00Z' };
      expect(decideRebookClick([onlyArchived])).toEqual({ kind: 'post', propertyId: 'prop-old' });
    });

    it('opens the picker for two archived properties (still ambiguous which one)', () => {
      const archivedA: RebookProperty = { id: 'prop-a', address: '1 A St', archivedAt: '2026-01-01T00:00:00Z' };
      const archivedB: RebookProperty = { id: 'prop-b', address: '2 B St', archivedAt: '2026-01-02T00:00:00Z' };
      expect(decideRebookClick([archivedA, archivedB])).toEqual({ kind: 'pick' });
    });
  });
});
