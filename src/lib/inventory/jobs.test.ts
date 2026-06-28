import { describe, it, expect } from 'vitest';
import { isActiveFulfillment, groupByStage, type FulfillmentCard } from './jobs';

const card = (over: Partial<FulfillmentCard>): FulfillmentCard => ({
  id: 'j1',
  jobNumber: 1000,
  quoteId: 'q1',
  designId: null,
  stage: 'to_be_ordered',
  status: 'to_schedule',
  customerName: 'A',
  customerAddress: '1 St',
  itemCount: 0,
  installDate: null,
  ...over,
});

describe('isActiveFulfillment', () => {
  it('is active only pre-install (to_schedule / scheduled)', () => {
    expect(isActiveFulfillment('to_schedule')).toBe(true);
    expect(isActiveFulfillment('scheduled')).toBe(true);
    expect(isActiveFulfillment('installed')).toBe(false);
    expect(isActiveFulfillment('requires_invoicing')).toBe(false);
    expect(isActiveFulfillment('done')).toBe(false);
    expect(isActiveFulfillment('cancelled')).toBe(false);
  });
});

describe('groupByStage', () => {
  it('buckets cards into all four columns (empty columns present, order stable)', () => {
    const g = groupByStage([
      card({ id: 'a', stage: 'to_be_ordered' }),
      card({ id: 'b', stage: 'ready_for_install' }),
      card({ id: 'c', stage: 'to_be_ordered' }),
    ]);
    expect(Object.keys(g)).toEqual([
      'to_be_ordered',
      'awaiting_pickup',
      'to_be_prepared',
      'ready_for_install',
    ]);
    expect(g.to_be_ordered.map((c) => c.id)).toEqual(['a', 'c']);
    expect(g.awaiting_pickup).toEqual([]);
    expect(g.ready_for_install.map((c) => c.id)).toEqual(['b']);
  });
});
