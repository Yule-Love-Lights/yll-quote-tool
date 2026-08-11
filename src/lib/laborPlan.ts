/**
 * The one legal door onto a job's stored labor numbers.
 *
 * Every `jobs.budgeted_hours` and `jobs.labor_revenue_cents` value in
 * production today was computed from PLACEHOLDER production rates (invented
 * minutes-per-item figures in `BUSINESS_RULES.laborPlanningPlaceholders`), and
 * `jobs.rates_are_placeholder` marks which rows those are. Real rates need the
 * Naldo and Jason seed-rates session, which has no date yet.
 *
 * Before this module, the flag was write-only: nothing read it, so any future
 * payout, labor-cost, or labor-margin screen could pull a bare number off a
 * `JobRow` and show an invented figure as if it were real. This module makes
 * that impossible to do by accident:
 *
 * - `readLaborPlan` returns a DISCRIMINATED UNION. There is no way to reach a
 *   number without first narrowing on `status`, which means a caller has to see
 *   the word `placeholder` to get past the type checker.
 * - `requireRealLaborPlan` THROWS on placeholder rates. Any pay math that must
 *   not run on invented numbers calls this and gets a hard stop, not a wrong
 *   paycheck.
 * - An ESLint rule (see `eslint.config.mjs`) bans reading the raw
 *   `budgeted_hours` / `labor_revenue_cents` columns anywhere outside this
 *   module and the row-mapping layer, so a future caller cannot quietly route
 *   around the door. That rule is the part a caller cannot ignore; the types
 *   are the part that makes doing it right easy.
 *
 * See `docs/context/project_p4p_labor.md` A6 item 12 for the recompute work
 * that eventually clears the flag.
 */

/** The subset of a job row this module needs. Kept structural so callers can pass a `JobRow`. */
export type LaborPlanSource = {
  id: string;
  budgeted_hours: number | null;
  labor_revenue_cents: number | null;
  rates_are_placeholder: boolean;
};

export type LaborPlan =
  | { status: 'none' }
  | {
      status: 'placeholder';
      budgetedHours: number;
      laborRevenueCents: number;
      /** Display-ready reason this number cannot be trusted yet. */
      warning: string;
    }
  | { status: 'real'; budgetedHours: number; laborRevenueCents: number };

const PLACEHOLDER_WARNING =
  'These hours and labor-revenue figures come from placeholder production rates, not measured ones. ' +
  'They are for planning shape only and must not be used to pay anyone until the seed-rates session sets real numbers.';

export class PlaceholderRatesError extends Error {
  readonly jobId: string;

  constructor(jobId: string, detail: string) {
    super(
      `Refusing to use labor numbers for job ${jobId}: ${detail}. ` +
        'These figures come from placeholder production rates and are not payable. ' +
        'They stay unusable until the Naldo and Jason seed-rates session produces real rates and the ' +
        'recompute pass clears jobs.rates_are_placeholder (project_p4p_labor.md A6 item 12).',
    );
    this.name = 'PlaceholderRatesError';
    this.jobId = jobId;
  }
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a job's labor numbers as a tagged value.
 *
 * `none` covers both "no estimate was ever computed" and "the row is only half
 * populated". A half-populated row is deliberately NOT reported as usable: one
 * of the two numbers missing means the pair cannot be trusted together, and a
 * silent zero on the missing half is exactly the kind of thing that reads as a
 * real answer downstream.
 */
export function readLaborPlan(job: LaborPlanSource): LaborPlan {
  const budgetedHours = finiteOrNull(job.budgeted_hours);
  const laborRevenueCents = finiteOrNull(job.labor_revenue_cents);

  if (budgetedHours === null || laborRevenueCents === null) return { status: 'none' };

  if (job.rates_are_placeholder) {
    return {
      status: 'placeholder',
      budgetedHours,
      laborRevenueCents,
      warning: PLACEHOLDER_WARNING,
    };
  }

  return { status: 'real', budgetedHours, laborRevenueCents };
}

/**
 * The numbers, or a hard stop.
 *
 * Call this from anything that computes pay, labor cost, or labor margin. It
 * throws rather than returning a fallback, because a fallback here is a wrong
 * number wearing a right number's clothes.
 */
export function requireRealLaborPlan(job: LaborPlanSource): {
  budgetedHours: number;
  laborRevenueCents: number;
} {
  const plan = readLaborPlan(job);

  if (plan.status === 'none') {
    throw new PlaceholderRatesError(job.id, 'no labor estimate has been computed for it');
  }
  if (plan.status === 'placeholder') {
    throw new PlaceholderRatesError(job.id, 'its rates are still flagged as placeholder');
  }

  return { budgetedHours: plan.budgetedHours, laborRevenueCents: plan.laborRevenueCents };
}

/** A one-line, screen-ready rendering of a plan. Placeholder plans say so first. */
export function describeLaborPlan(plan: LaborPlan): string {
  if (plan.status === 'none') return 'No labor estimate computed';

  const dollars = (plan.laborRevenueCents / 100).toFixed(2);
  const body = `${plan.budgetedHours} budgeted hours, $${dollars} labor revenue`;

  return plan.status === 'placeholder' ? `Placeholder rates: ${body}` : body;
}
