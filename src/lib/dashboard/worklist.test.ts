import { describe, it, expect } from 'vitest';
import { computeWorklist } from './worklist';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

const NOW = new Date('2026-06-24T12:00:00Z');

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Smith Family',
    customer_email: null,
    customer_phone: null,
    total: 1500,
    created_at: '2026-06-20T12:00:00Z',
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

describe('computeWorklist — empty', () => {
  it('returns [] on empty input', () => {
    expect(computeWorklist([], NOW)).toEqual([]);
  });
});

describe('computeWorklist — draft-stale', () => {
  it('does NOT surface a quote drafted within the draftStaleDays window', () => {
    const recent = new Date(NOW.getTime() - 0.5 * 86400_000).toISOString();
    const out = computeWorklist([makeQuote({ created_at: recent })], NOW);
    expect(out).toEqual([]);
  });

  it('surfaces a quote drafted more than draftStaleDays ago with no quote_sent_at', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.draftStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist([makeQuote({ id: 'q1', created_at: old })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('draft-stale');
    expect(out[0].quoteId).toBe('q1');
    expect(out[0].href).toBe('/quote/q1');
  });

  it('does NOT nag a won quote that was approved without ever being marked sent', () => {
    // /approve sets customer_approved_at but not quote_sent_at (offline close).
    // The old draft branch keyed only off !quote_sent_at → it wrongly showed
    // this won deal as a stale "never sent" draft. Regression guard.
    const old = new Date(NOW.getTime() - 174 * 86400_000).toISOString();
    const out = computeWorklist(
      [makeQuote({ created_at: old, quote_sent_at: null, customer_approved_at: '2026-03-01T00:00:00Z' })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('surfaces a draft exactly at the draftStaleDays boundary (uses ≥)', () => {
    const exactly = new Date(
      NOW.getTime() - DASHBOARD_CONFIG.draftStaleDays * 86400_000,
    ).toISOString();
    const out = computeWorklist([makeQuote({ id: 'qb', created_at: exactly })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('draft-stale');
  });
});

describe('computeWorklist — sent-no-reply', () => {
  it('does NOT surface a quote sent within the sentNoReplyStaleDays window', () => {
    const recent = new Date(NOW.getTime() - 0.5 * 86400_000).toISOString();
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: recent })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('surfaces a quote sent more than sentNoReplyStaleDays ago with no approval', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.sentNoReplyStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist(
      [makeQuote({ id: 'q2', created_at: '2026-06-01T00:00:00Z', quote_sent_at: old })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('sent-no-reply');
    expect(out[0].quoteId).toBe('q2');
    expect(out[0].href).toBe('/portal/q2');
  });

  it('does NOT surface an approved quote even if sent long ago', () => {
    const old = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
    const out = computeWorklist(
      [makeQuote({
        quote_sent_at: old,
        customer_approved_at: new Date(NOW.getTime() - 25 * 86400_000).toISOString(),
      })],
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe('computeWorklist — terminal statuses never nag (#110 W7-007, B7 class)', () => {
  const oldSent = new Date(
    NOW.getTime() - (DASHBOARD_CONFIG.sentNoReplyStaleDays + 5) * 86400_000,
  ).toISOString();
  const oldDraft = new Date(
    NOW.getTime() - (DASHBOARD_CONFIG.draftStaleDays + 5) * 86400_000,
  ).toISOString();

  it('a declined quote (sent long ago, no approval) does NOT show as sent-no-reply', () => {
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: oldSent, status: 'declined' })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('a cancelled quote does NOT nag', () => {
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: oldSent, status: 'cancelled' })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('a lost quote does NOT nag', () => {
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: oldSent, status: 'lost' })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('a changes_requested quote does NOT nag as sent-no-reply (mirrors needsAction/workflowBoard)', () => {
    const out = computeWorklist(
      [makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: oldSent, status: 'changes_requested' })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('a cancelled never-sent draft does NOT nag as draft-stale', () => {
    const out = computeWorklist(
      [makeQuote({ created_at: oldDraft, quote_sent_at: null, status: 'cancelled' })],
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe('computeWorklist - subtitle context (WT-40)', () => {
  it('includes quote_number, service type, and address so multi-quote rows are distinguishable', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.draftStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist(
      [
        makeQuote({
          id: 'q1',
          created_at: old,
          quote_number: 1032,
          service_type: 'permanent',
          customer_address: '1234 Main St',
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].subtitle).toContain('#1032');
    expect(out[0].subtitle).toContain('Permanent');
    expect(out[0].subtitle).toContain('1234 Main St');
  });

  it('falls back to just the service label when quote_number and address are absent', () => {
    const old = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.draftStaleDays + 2) * 86400_000,
    ).toISOString();
    const out = computeWorklist([makeQuote({ id: 'q2', created_at: old })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].subtitle).toContain('Holiday');
    expect(out[0].subtitle).not.toContain('#');
  });
});

describe('computeWorklist — sorting + cap', () => {
  it('sorts oldest-stale first (most overdue at the top)', () => {
    const aDay = 86400_000;
    const out = computeWorklist(
      [
        makeQuote({ id: 'newer', created_at: new Date(NOW.getTime() - 2 * aDay).toISOString() }),
        makeQuote({ id: 'older', created_at: new Date(NOW.getTime() - 10 * aDay).toISOString() }),
      ],
      NOW,
    );
    expect(out.map(r => r.quoteId)).toEqual(['older', 'newer']);
    expect(out[0].ageDays).toBeGreaterThan(out[1].ageDays);
  });

  it('caps the row count at worklistMaxRows', () => {
    const aDay = 86400_000;
    const rows = Array.from({ length: DASHBOARD_CONFIG.worklistMaxRows + 5 }, (_, i) =>
      makeQuote({ id: `q${i}`, created_at: new Date(NOW.getTime() - (i + 2) * aDay).toISOString() }),
    );
    expect(computeWorklist(rows, NOW)).toHaveLength(DASHBOARD_CONFIG.worklistMaxRows);
  });
});
