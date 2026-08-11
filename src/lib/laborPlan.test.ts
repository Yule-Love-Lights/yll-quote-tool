import { describe, expect, it } from 'vitest';

import {
  PlaceholderRatesError,
  describeLaborPlan,
  readLaborPlan,
  requireRealLaborPlan,
} from './laborPlan';

const job = (
  overrides: Partial<{
    id: string;
    budgeted_hours: number | null;
    labor_revenue_cents: number | null;
    rates_are_placeholder: boolean;
  }> = {},
) => ({
  id: 'job-1',
  budgeted_hours: 12.5,
  labor_revenue_cents: 264_00,
  rates_are_placeholder: false,
  ...overrides,
});

describe('readLaborPlan', () => {
  it('reports real numbers as real', () => {
    expect(readLaborPlan(job())).toEqual({
      status: 'real',
      budgetedHours: 12.5,
      laborRevenueCents: 264_00,
    });
  });

  it('reports placeholder numbers as placeholder, and still carries them', () => {
    const plan = readLaborPlan(job({ rates_are_placeholder: true }));
    expect(plan.status).toBe('placeholder');
    if (plan.status !== 'placeholder') throw new Error('narrowing failed');
    expect(plan.budgetedHours).toBe(12.5);
    expect(plan.laborRevenueCents).toBe(264_00);
    expect(plan.warning).toContain('placeholder');
  });

  it('reports a job with no computed numbers as none, not as a zero', () => {
    expect(
      readLaborPlan(job({ budgeted_hours: null, labor_revenue_cents: null })),
    ).toMatchObject({ status: 'none' });
  });

  it('reports a legacy row (flag defaulted true, nothing ever computed) as none', () => {
    // `rates_are_placeholder` defaults to true, so every job that predates the
    // column reads as placeholder while carrying no numbers at all. There is
    // nothing to warn about on those.
    expect(
      readLaborPlan(
        job({ budgeted_hours: null, labor_revenue_cents: null, rates_are_placeholder: true }),
      ),
    ).toMatchObject({ status: 'none' });
  });

  it('refuses to half-trust a row with only one of the two numbers', () => {
    expect(readLaborPlan(job({ labor_revenue_cents: null }))).toMatchObject({ status: 'none' });
    expect(readLaborPlan(job({ budgeted_hours: null }))).toMatchObject({ status: 'none' });
  });

  it('treats a non-finite stored number as none rather than propagating NaN into pay math', () => {
    expect(readLaborPlan(job({ budgeted_hours: Number.NaN }))).toMatchObject({ status: 'none' });
  });

  it('treats zeroed numbers as a real answer when the rates are real', () => {
    // Zero budgeted hours is a legitimate computed result, not a missing one.
    expect(readLaborPlan(job({ budgeted_hours: 0, labor_revenue_cents: 0 }))).toEqual({
      status: 'real',
      budgetedHours: 0,
      laborRevenueCents: 0,
    });
  });
});

describe('requireRealLaborPlan', () => {
  it('returns the numbers when the rates are real', () => {
    expect(requireRealLaborPlan(job())).toEqual({
      budgetedHours: 12.5,
      laborRevenueCents: 264_00,
    });
  });

  it('throws on placeholder rates instead of returning a number that looks real', () => {
    expect(() => requireRealLaborPlan(job({ rates_are_placeholder: true }))).toThrow(
      PlaceholderRatesError,
    );
  });

  it('names the job and the reason in the error, so the log is actionable', () => {
    try {
      requireRealLaborPlan(job({ id: 'job-abc', rates_are_placeholder: true }));
      throw new Error('expected requireRealLaborPlan to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PlaceholderRatesError);
      const message = (error as Error).message;
      expect(message).toContain('job-abc');
      expect(message).toContain('seed-rates');
    }
  });

  it('throws when there are no numbers at all', () => {
    expect(() =>
      requireRealLaborPlan(job({ budgeted_hours: null, labor_revenue_cents: null })),
    ).toThrow(PlaceholderRatesError);
  });
});

describe('describeLaborPlan', () => {
  it('labels a placeholder plan loudly enough to read on a screen', () => {
    const text = describeLaborPlan(readLaborPlan(job({ rates_are_placeholder: true })));
    expect(text).toContain('Placeholder');
    expect(text).toContain('12.5');
  });

  it('labels a real plan without a warning', () => {
    const text = describeLaborPlan(readLaborPlan(job()));
    expect(text).toContain('12.5');
    expect(text.toLowerCase()).not.toContain('placeholder');
  });

  it('says plainly when nothing was computed', () => {
    const text = describeLaborPlan(
      readLaborPlan(job({ budgeted_hours: null, labor_revenue_cents: null })),
    );
    expect(text).toContain('No labor estimate');
  });
});
