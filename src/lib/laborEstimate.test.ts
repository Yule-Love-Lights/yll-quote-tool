import { describe, expect, it } from 'vitest';

import { buildQuoteInputs, initialFormData } from './quoteForm';
import { makeDefaultPermanentFields } from './permanent/types';
import { estimateLaborForQuote } from './laborEstimate';

describe('estimateLaborForQuote', () => {
  it('returns 0/0 for a zero-geometry holiday quote', () => {
    const estimate = estimateLaborForQuote('holiday', buildQuoteInputs(initialFormData));

    expect(estimate).toMatchObject({
      budgetedHours: 0,
      laborRevenueCents: 0,
      ratesArePlaceholder: true,
      unmappedCategories: [],
    });
  });

  it('uses the conservative default for unmapped custom line items instead of silently computing 0', () => {
    const estimate = estimateLaborForQuote(
      'holiday',
      buildQuoteInputs({
        ...initialFormData,
        customLineItems: [{ label: 'Odd install', amount: 125, quantity: 2 }],
      }),
    );

    expect(estimate).not.toBeNull();
    expect(estimate?.budgetedHours).toBe(1);
    expect(estimate?.unmappedCategories).toEqual(['customLineItems']);
  });

  it('stores labor revenue as integer cents, never a float', () => {
    const estimate = estimateLaborForQuote(
      'holiday',
      buildQuoteInputs({
        ...initialFormData,
        santasFootage: 1,
        santasDifficulty: 'easy',
      }),
    );

    expect(estimate).not.toBeNull();
    expect(Number.isInteger(estimate?.laborRevenueCents)).toBe(true);
    expect(estimate?.laborRevenueCents).toBe(264);
  });

  it('estimates permanent jobs from the saved permanent geometry block', () => {
    const estimate = estimateLaborForQuote(
      'permanent',
      buildQuoteInputs({
        ...initialFormData,
        serviceType: 'permanent',
        permanent: { ...makeDefaultPermanentFields(), frontFootage: 70, backFootage: 35 },
      }),
    );

    expect(estimate).toMatchObject({
      budgetedHours: 15,
      ratesArePlaceholder: true,
      unmappedCategories: [],
    });
  });

  it('returns null when a service type is missing the saved geometry block it depends on', () => {
    expect(estimateLaborForQuote('permanent', buildQuoteInputs(initialFormData))).toBeNull();
  });

  it('returns null for a permanent_bistro quote with no saved bistro geometry (not a confident $0/0-hour estimate)', () => {
    // Regression test for the S57 wrap review finding: sanitizePermanentBistroBlock
    // used to return {} instead of undefined on an empty block. {} is truthy, so
    // sanitizeQuoteInputs' `permanentBistro === undefined` guard never fired, and an
    // empty bistro quote silently priced as a real (wrong) zero-hour job instead of
    // this null "unknown, don't estimate" result. This mirrors the 'permanent' test
    // above — same contract, the sibling service type that had it right already.
    expect(
      estimateLaborForQuote(
        'permanent_bistro',
        buildQuoteInputs({ ...initialFormData, serviceType: 'permanent_bistro' }),
      ),
    ).toBeNull();
  });
});
