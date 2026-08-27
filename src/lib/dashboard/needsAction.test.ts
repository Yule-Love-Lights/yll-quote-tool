import { describe, it, expect } from 'vitest';
import { buildNeedsAction } from './needsAction';
import type { NeedsActionInput } from './needsAction';
import type { DashboardQuote } from './types';

// A fixed "now" so all age math is deterministic.
const NOW_ISO = '2026-07-01T12:00:00Z';
const NOW_MS = new Date(NOW_ISO).getTime();
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

// Minimal DashboardQuote factory — only the fields needsAction reads.
function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: 'q-default',
    customer_name: 'Smith Family',
    customer_email: 'smith@example.com',
    customer_phone: null,
    total: 1200,
    created_at: daysAgo(10),
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    status: null,
    viewed_at: null,
    ...over,
  };
}

// Minimal input factory.
function makeInput(over: Partial<NeedsActionInput> = {}): NeedsActionInput {
  return { nowMs: NOW_MS, quotes: [], jobs: [], invoices: [], ...over };
}

// ─── Empty / no-op cases ─────────────────────────────────────────────────────

describe('buildNeedsAction — empty', () => {
  it('returns [] on empty input', () => {
    expect(buildNeedsAction(makeInput())).toEqual([]);
  });
});

// ─── Bucket 1: nudge — sent/viewed, no approval, ≥ 3 days since quote_sent_at ─

describe('buildNeedsAction — nudge (follow-up on sent quote)', () => {
  it('surfaces a sent quote older than 3 days as nudge', () => {
    const q = makeQuote({ id: 'q1', quote_sent_at: daysAgo(4) });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('nudge');
    expect(items[0].quoteId).toBe('q1');
    expect(items[0].href).toBe('/portal/q1');
    expect(items[0].ageDays).toBeGreaterThanOrEqual(3);
  });

  it('surfaces a viewed quote older than 3 days as nudge', () => {
    const q = makeQuote({
      id: 'q2',
      quote_sent_at: daysAgo(5),
      viewed_at: daysAgo(4),
    });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('nudge');
    expect(items[0].quoteId).toBe('q2');
  });

  it('does NOT surface a sent quote less than 3 days old', () => {
    const q = makeQuote({ id: 'q3', quote_sent_at: daysAgo(1) });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('does NOT surface an approved quote as a nudge (it may surface as collect-deposit)', () => {
    const q = makeQuote({
      id: 'q4',
      quote_sent_at: daysAgo(10),
      customer_approved_at: daysAgo(5),
    });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items.every((i) => i.kind !== 'nudge')).toBe(true);
  });

  it('does NOT surface a booked quote (deposit paid)', () => {
    const q = makeQuote({
      id: 'q5',
      quote_sent_at: daysAgo(10),
      customer_approved_at: daysAgo(8),
      deposit_paid_at: daysAgo(7),
    });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('surfaces a sent quote at exactly 3 days (boundary — ≥)', () => {
    const q = makeQuote({ id: 'q6', quote_sent_at: daysAgo(3) });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('nudge');
  });
});

// ─── Bucket 2: collect-deposit — approved, not booked, ≥ 2 days ─────────────

describe('buildNeedsAction — collect-deposit', () => {
  it('surfaces an approved-not-booked quote older than 2 days', () => {
    const q = makeQuote({
      id: 'q10',
      quote_sent_at: daysAgo(10),
      customer_approved_at: daysAgo(3),
    });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('collect-deposit');
    expect(items[0].quoteId).toBe('q10');
    expect(items[0].href).toBe('/quote/q10');
  });

  it('does NOT surface an approved quote approved less than 2 days ago', () => {
    const q = makeQuote({
      id: 'q11',
      quote_sent_at: daysAgo(5),
      customer_approved_at: daysAgo(1),
    });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('does NOT surface a booked (deposit paid) quote even if old', () => {
    const q = makeQuote({
      id: 'q12',
      quote_sent_at: daysAgo(15),
      customer_approved_at: daysAgo(10),
      deposit_paid_at: daysAgo(9),
    });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('surfaces at exactly 2 days (boundary — ≥)', () => {
    const q = makeQuote({
      id: 'q13',
      customer_approved_at: daysAgo(2),
    });
    const items = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('collect-deposit');
  });
});

// ─── Bucket 3: collect-balance — job requires_invoicing + unpaid invoice ─────

describe('buildNeedsAction — collect-balance', () => {
  it('surfaces a requires_invoicing job with an awaiting_payment invoice older than 2 days', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q20' })],
        jobs: [{ id: 'j1', quote_id: 'q20', status: 'requires_invoicing', created_at: daysAgo(5) }],
        invoices: [
          {
            id: 'inv1',
            job_id: 'j1',
            quote_id: 'q20',
            status: 'awaiting_payment',
            balance: 500,
            created_at: daysAgo(3),
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('collect-balance');
    expect(items[0].quoteId).toBe('q20');
    expect(items[0].href).toBe('/admin/invoices/inv1');
    expect(items[0].detail).toContain('$500');
  });

  it('surfaces a requires_invoicing job with a draft invoice older than 2 days', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q21' })],
        jobs: [{ id: 'j2', quote_id: 'q21', status: 'requires_invoicing', created_at: daysAgo(4) }],
        invoices: [
          {
            id: 'inv2',
            job_id: 'j2',
            quote_id: 'q21',
            status: 'draft',
            balance: 300,
            created_at: daysAgo(3),
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('collect-balance');
  });

  it('does NOT surface a paid invoice', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q22' })],
        jobs: [{ id: 'j3', quote_id: 'q22', status: 'requires_invoicing', created_at: daysAgo(4) }],
        invoices: [
          {
            id: 'inv3',
            job_id: 'j3',
            quote_id: 'q22',
            status: 'paid',
            balance: 0,
            created_at: daysAgo(3),
          },
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  it('does NOT surface an invoice younger than 2 days', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q23' })],
        jobs: [{ id: 'j4', quote_id: 'q23', status: 'requires_invoicing', created_at: daysAgo(4) }],
        invoices: [
          {
            id: 'inv4',
            job_id: 'j4',
            quote_id: 'q23',
            status: 'awaiting_payment',
            balance: 400,
            created_at: daysAgo(1),
          },
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  it('does NOT surface a job that is not requires_invoicing', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q24' })],
        jobs: [{ id: 'j5', quote_id: 'q24', status: 'to_schedule', created_at: daysAgo(5) }],
        invoices: [
          {
            id: 'inv5',
            job_id: 'j5',
            quote_id: 'q24',
            status: 'awaiting_payment',
            balance: 400,
            created_at: daysAgo(3),
          },
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  it('surfaces at exactly 2 days (boundary — ≥)', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q25' })],
        jobs: [{ id: 'j6', quote_id: 'q25', status: 'requires_invoicing', created_at: daysAgo(4) }],
        invoices: [
          {
            id: 'inv6',
            job_id: 'j6',
            quote_id: 'q25',
            status: 'awaiting_payment',
            balance: 200,
            created_at: daysAgo(2),
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('collect-balance');
  });

  // Row 389 (S49): a stale invoice's balance is a frozen, unreconciled
  // figure — the nag must say so rather than presenting it as gospel.
  it('flags a STALE invoice in the detail copy instead of presenting the balance as gospel', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q26' })],
        jobs: [{ id: 'j7', quote_id: 'q26', status: 'requires_invoicing', created_at: daysAgo(5) }],
        invoices: [
          {
            id: 'inv7',
            job_id: 'j7',
            quote_id: 'q26',
            status: 'awaiting_payment',
            balance: 700,
            created_at: daysAgo(3),
            stale: true,
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain('$700');
    expect(items[0].detail).toMatch(/unreconciled/i);
  });

  it('does NOT mention "unreconciled" for an ordinary (non-stale) invoice', () => {
    const items = buildNeedsAction(
      makeInput({
        quotes: [makeQuote({ id: 'q27' })],
        jobs: [{ id: 'j8', quote_id: 'q27', status: 'requires_invoicing', created_at: daysAgo(5) }],
        invoices: [
          {
            id: 'inv8',
            job_id: 'j8',
            quote_id: 'q27',
            status: 'awaiting_payment',
            balance: 900,
            created_at: daysAgo(3),
            stale: false,
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].detail).not.toMatch(/unreconciled/i);
  });
});

// ─── Terminal / is_test exclusions ───────────────────────────────────────────

describe('buildNeedsAction — terminal & is_test exclusions', () => {
  it('excludes a declined quote', () => {
    const q = makeQuote({ id: 'qd', quote_sent_at: daysAgo(10), status: 'declined' });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('excludes a cancelled quote', () => {
    const q = makeQuote({ id: 'qc', quote_sent_at: daysAgo(10), status: 'cancelled' });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('excludes an abandoned quote', () => {
    const q = makeQuote({ id: 'ql', quote_sent_at: daysAgo(10), status: 'abandoned' });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('excludes a changes_requested quote', () => {
    const q = makeQuote({ id: 'qcr', quote_sent_at: daysAgo(10), status: 'changes_requested' });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });

  it('excludes a test quote (is_test)', () => {
    const q = makeQuote({ id: 'qt', quote_sent_at: daysAgo(10), is_test: true } as DashboardQuote & { is_test: boolean });
    expect(buildNeedsAction(makeInput({ quotes: [q] }))).toEqual([]);
  });
});

// ─── Sorting: most urgent (oldest) first ────────────────────────────────────

describe('buildNeedsAction — sorting', () => {
  it('sorts most-urgent (oldest) first across all buckets', () => {
    const q_nudge_old = makeQuote({ id: 'n-old', quote_sent_at: daysAgo(10) });
    const q_nudge_new = makeQuote({ id: 'n-new', quote_sent_at: daysAgo(4) });
    const q_deposit = makeQuote({ id: 'd', customer_approved_at: daysAgo(5) });

    const items = buildNeedsAction(
      makeInput({ quotes: [q_nudge_new, q_deposit, q_nudge_old] }),
    );

    expect(items.length).toBe(3);
    // Oldest first.
    expect(items[0].ageDays).toBeGreaterThanOrEqual(items[1].ageDays);
    expect(items[1].ageDays).toBeGreaterThanOrEqual(items[2].ageDays);
    // The oldest nudge is first.
    expect(items[0].quoteId).toBe('n-old');
  });
});

// ─── quote_number + service_type carried onto rows (WT-40) ───────────────────

describe('buildNeedsAction — quote_number + service_type on items (WT-40)', () => {
  it('carries quote_number + service_type onto a nudge item', () => {
    const q = makeQuote({ id: 'q-num', quote_sent_at: daysAgo(4), quote_number: 2001, service_type: 'event' });
    const [item] = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(item.quoteNumber).toBe(2001);
    expect(item.serviceType).toBe('event');
  });

  it('carries quote_number + service_type onto a collect-deposit item', () => {
    const q = makeQuote({
      id: 'q-dep',
      customer_approved_at: daysAgo(3),
      quote_number: 3005,
      service_type: 'permanent',
    });
    const [item] = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(item.quoteNumber).toBe(3005);
    expect(item.serviceType).toBe('permanent');
  });

  it('quoteNumber is null when the row has no allocated number (legacy row)', () => {
    const q = makeQuote({ id: 'q-nonum', quote_sent_at: daysAgo(4) });
    const [item] = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(item.quoteNumber).toBeNull();
  });
});

// ─── label / detail formatting ───────────────────────────────────────────────

describe('buildNeedsAction — item shape', () => {
  it('nudge item has correct label and detail', () => {
    const q = makeQuote({ id: 'q-shape', customer_name: 'Jones', quote_sent_at: daysAgo(5) });
    const [item] = buildNeedsAction(makeInput({ quotes: [q] }));
    expect(item.label).toMatch(/Jones/);
    expect(item.detail).toMatch(/5 day/i);
    expect(item.quoteId).toBe('q-shape');
  });

  it('collect-balance detail includes the dollar amount', () => {
    const q = makeQuote({ id: 'q-bal' });
    const items = buildNeedsAction(
      makeInput({
        quotes: [q],
        jobs: [{ id: 'jbal', quote_id: 'q-bal', status: 'requires_invoicing', created_at: daysAgo(5) }],
        invoices: [
          {
            id: 'ibal',
            job_id: 'jbal',
            quote_id: 'q-bal',
            status: 'awaiting_payment',
            balance: 750,
            created_at: daysAgo(3),
          },
        ],
      }),
    );
    expect(items[0].detail).toContain('$750');
  });
});
