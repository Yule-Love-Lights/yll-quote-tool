import { describe, it, expect } from 'vitest';
import {
  computeHolidayBreakdown,
  computePermanentSummary,
  computeEventSummary,
  computeBistroSummary,
  serviceTypeOf,
} from './serviceMetrics';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Test',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-09-01T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...over,
  };
}

describe('serviceTypeOf — fallback', () => {
  it('returns the literal when set', () => {
    expect(serviceTypeOf(makeQuote({ service_type: 'permanent' }))).toBe('permanent');
    expect(serviceTypeOf(makeQuote({ service_type: 'event' }))).toBe('event');
    expect(serviceTypeOf(makeQuote({ service_type: 'holiday' }))).toBe('holiday');
  });
  it('treats NULL as holiday (legacy default)', () => {
    expect(serviceTypeOf(makeQuote({ service_type: null }))).toBe('holiday');
  });
});

describe('computeHolidayBreakdown — totals', () => {
  it('counts only approved holiday quotes as booked', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-10T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-10-15T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: null }), // not booked
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-01T00:00:00Z' }), // wrong service
        makeQuote({ service_type: null, customer_approved_at: '2026-11-01T00:00:00Z' }),       // NULL → holiday
      ],
    );
    expect(out.bookedTotal).toBe(3);
  });

  it('counts only signed holiday quotes as installed (homeworks_signed_at proxy)', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({
          service_type: 'holiday',
          customer_approved_at: '2026-09-10T00:00:00Z',
          homeworks_signed_at: '2026-10-01T00:00:00Z',
        }),
        makeQuote({
          service_type: 'holiday',
          customer_approved_at: '2026-09-10T00:00:00Z',
          homeworks_signed_at: null, // booked but not installed
        }),
      ],
    );
    expect(out.installedTotal).toBe(1);
  });

  it('groups booked + installed by install month (YYYY-MM key, label, stable order)', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-05T00:00:00Z', homeworks_signed_at: '2026-09-25T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-20T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-10-01T00:00:00Z', homeworks_signed_at: '2026-10-10T00:00:00Z' }),
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-12-01T00:00:00Z' }),
      ],
    );
    const sepBucket = out.byMonth.find(b => b.key === '2026-09');
    const octBucket = out.byMonth.find(b => b.key === '2026-10');
    const decBucket = out.byMonth.find(b => b.key === '2026-12');
    expect(sepBucket).toEqual(expect.objectContaining({ booked: 2, installed: 1 }));
    expect(octBucket).toEqual(expect.objectContaining({ booked: 1, installed: 1 }));
    expect(decBucket).toEqual(expect.objectContaining({ booked: 1, installed: 0 }));
    // Stable chronological order
    const keys = out.byMonth.map(b => b.key);
    expect(keys).toEqual([...keys].sort());
  });

  it('goal mirrors config + total booked', () => {
    const out = computeHolidayBreakdown(
      [makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-10T00:00:00Z' })],
    );
    expect(out.goal.goal).toBe(DASHBOARD_CONFIG.holidaySeasonGoalHomes);
    expect(out.goal.booked).toBe(1);
  });

  it('attributes a booking to its INSTALL month (homeworks_signed_at), not its approval month', () => {
    // Approved Sep, installed (signed) Oct → both booked+installed land in 2026-10,
    // NOT 2026-09. Locks the documented install-month-preference rule.
    const out = computeHolidayBreakdown([
      makeQuote({
        service_type: 'holiday',
        customer_approved_at: '2026-09-10T00:00:00Z',
        homeworks_signed_at: '2026-10-05T00:00:00Z',
      }),
    ]);
    expect(out.byMonth.find(b => b.key === '2026-09')).toBeUndefined();
    expect(out.byMonth.find(b => b.key === '2026-10')).toEqual(
      expect.objectContaining({ booked: 1, installed: 1 }),
    );
  });

  it('pending = sent-not-approved holiday quotes (WT-39 parity w/ Permanent/Event/Bistro)', () => {
    const out = computeHolidayBreakdown(
      [
        makeQuote({ service_type: 'holiday', customer_approved_at: '2026-09-10T00:00:00Z' }), // booked
        makeQuote({ service_type: 'holiday', quote_sent_at: '2026-11-01T00:00:00Z' }), // pending
        makeQuote({
          service_type: 'holiday',
          quote_sent_at: '2026-11-01T00:00:00Z',
          customer_approved_at: '2026-11-05T00:00:00Z',
        }), // sent AND approved → booked, not pending
        makeQuote({ service_type: 'holiday' }), // neither sent nor approved → not counted at all
        makeQuote({ service_type: 'permanent', quote_sent_at: '2026-11-01T00:00:00Z' }), // wrong service
      ],
    );
    expect(out.bookedTotal).toBe(2);
    expect(out.pending).toBe(1);
  });

  it('a cancelled sent-not-approved holiday quote does NOT count as pending (B7 parity)', () => {
    const out = computeHolidayBreakdown([
      makeQuote({ service_type: 'holiday', quote_sent_at: '2026-11-01T00:00:00Z', status: 'cancelled' }),
      makeQuote({ service_type: 'holiday', quote_sent_at: '2026-11-02T00:00:00Z' }),
    ]);
    expect(out.pending).toBe(1);
  });
});

describe('computeHolidayBreakdown — cancelled orders excluded (B7)', () => {
  it('a cancelled holiday quote with customer_approved_at does NOT count as booked', () => {
    const out = computeHolidayBreakdown([
      makeQuote({
        service_type: 'holiday',
        customer_approved_at: '2026-09-10T00:00:00Z',
        status: 'cancelled',
        total: 4000,
      }),
      makeQuote({
        service_type: 'holiday',
        customer_approved_at: '2026-09-11T00:00:00Z',
        total: 2000,
      }),
    ]);
    expect(out.bookedTotal).toBe(1); // only the non-cancelled one
  });
});

describe('computePermanentSummary — cancelled orders excluded (B7)', () => {
  it('a cancelled permanent quote with customer_approved_at does NOT count as inCare or revenue', () => {
    const out = computePermanentSummary([
      makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-10T00:00:00Z', total: 10000, status: 'cancelled' }),
      makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-10T00:00:00Z', total: 5000 }),
    ]);
    expect(out.inCare).toBe(1);
    expect(out.bookedRevenue).toBe(5000);
  });
});

describe('computeEventSummary — cancelled orders excluded (B7)', () => {
  it('a cancelled event quote with customer_approved_at does NOT count as booked or revenue', () => {
    const out = computeEventSummary([
      makeQuote({ service_type: 'event', customer_approved_at: '2026-10-01T00:00:00Z', total: 6000, status: 'cancelled' }),
      makeQuote({ service_type: 'event', customer_approved_at: '2026-10-02T00:00:00Z', total: 3000 }),
    ]);
    expect(out.booked).toBe(1);
    expect(out.bookedRevenue).toBe(3000);
  });
});

describe('computePermanentSummary', () => {
  it('inCare = count of approved permanent quotes; pending = sent-not-approved', () => {
    const out = computePermanentSummary(
      [
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-09-10T00:00:00Z', total: 13000 }),
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-10-10T00:00:00Z', total: 11000 }),
        makeQuote({ service_type: 'permanent', quote_sent_at: '2026-11-01T00:00:00Z' }),
        makeQuote({ service_type: 'holiday',   customer_approved_at: '2026-09-15T00:00:00Z' }), // wrong service
      ],
    );
    expect(out.inCare).toBe(2);
    expect(out.pending).toBe(1);
    expect(out.bookedRevenue).toBe(24000);
  });

  it('handles empty / no permanent quotes', () => {
    const out = computePermanentSummary([makeQuote({ service_type: 'holiday' })]);
    expect(out).toEqual({ inCare: 0, pending: 0, bookedRevenue: 0 });
  });
});

describe('computeEventSummary', () => {
  it('booked / pending / revenue from event quotes only', () => {
    const out = computeEventSummary(
      [
        makeQuote({ service_type: 'event', customer_approved_at: '2026-10-01T00:00:00Z', total: 4800 }),
        makeQuote({ service_type: 'event', quote_sent_at: '2026-11-01T00:00:00Z' }),
        makeQuote({ service_type: 'event', quote_sent_at: '2026-11-01T00:00:00Z', customer_approved_at: '2026-11-05T00:00:00Z', total: 6000 }),
        makeQuote({ service_type: 'permanent', customer_approved_at: '2026-10-01T00:00:00Z' }),
      ],
    );
    expect(out.booked).toBe(2);
    expect(out.pending).toBe(1);
    expect(out.bookedRevenue).toBe(10800);
  });
});

describe('computeBistroSummary (#117)', () => {
  it('booked / pending / revenue from permanent_bistro quotes only', () => {
    const out = computeBistroSummary(
      [
        makeQuote({ service_type: 'permanent_bistro', customer_approved_at: '2026-07-10T00:00:00Z', total: 217.5 }),
        makeQuote({ service_type: 'permanent_bistro', quote_sent_at: '2026-07-11T00:00:00Z' }),
        makeQuote({ service_type: 'permanent_bistro', quote_sent_at: '2026-07-11T00:00:00Z', customer_approved_at: '2026-07-12T00:00:00Z', total: 3000 }),
        makeQuote({ service_type: 'event', customer_approved_at: '2026-07-10T00:00:00Z', total: 999 }), // wrong service
      ],
    );
    expect(out.booked).toBe(2);
    expect(out.pending).toBe(1);
    expect(out.bookedRevenue).toBe(3217.5);
  });

  it('a cancelled bistro quote with customer_approved_at does NOT count as booked or revenue (B7)', () => {
    const out = computeBistroSummary([
      makeQuote({ service_type: 'permanent_bistro', customer_approved_at: '2026-07-10T00:00:00Z', total: 6000, status: 'cancelled' }),
      makeQuote({ service_type: 'permanent_bistro', customer_approved_at: '2026-07-11T00:00:00Z', total: 3000 }),
    ]);
    expect(out.booked).toBe(1);
    expect(out.bookedRevenue).toBe(3000);
  });

  it('handles empty / no bistro quotes', () => {
    const out = computeBistroSummary([makeQuote({ service_type: 'holiday' })]);
    expect(out).toEqual({ booked: 0, pending: 0, bookedRevenue: 0 });
  });
});
