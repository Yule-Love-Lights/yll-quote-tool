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
});
