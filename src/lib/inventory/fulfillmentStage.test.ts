import { describe, it, expect } from 'vitest';
import {
  FULFILLMENT_STAGES,
  FULFILLMENT_STAGE_LABELS,
  DEFAULT_FULFILLMENT_STAGE,
  asFulfillmentStage,
  fulfillmentStageOf,
} from './fulfillmentStage';

describe('fulfillment stage model (#82 Slice 3)', () => {
  it('has the 4 stages in fulfillment order; default = first', () => {
    expect(FULFILLMENT_STAGES).toEqual([
      'to_be_ordered',
      'awaiting_pickup',
      'to_be_prepared',
      'ready_for_install',
    ]);
    expect(DEFAULT_FULFILLMENT_STAGE).toBe('to_be_ordered');
  });

  it('labels every stage', () => {
    for (const s of FULFILLMENT_STAGES) expect(FULFILLMENT_STAGE_LABELS[s]).toBeTruthy();
  });

  it('asFulfillmentStage narrows a known value, rejects anything else', () => {
    expect(asFulfillmentStage('awaiting_pickup')).toBe('awaiting_pickup');
    expect(asFulfillmentStage('bogus')).toBeNull();
    expect(asFulfillmentStage(null)).toBeNull();
    expect(asFulfillmentStage(5)).toBeNull();
  });

  it('fulfillmentStageOf treats null/unknown as the default first stage (#83 leaves it NULL)', () => {
    expect(fulfillmentStageOf(null)).toBe('to_be_ordered');
    expect(fulfillmentStageOf('bogus')).toBe('to_be_ordered');
    expect(fulfillmentStageOf('ready_for_install')).toBe('ready_for_install');
  });
});
