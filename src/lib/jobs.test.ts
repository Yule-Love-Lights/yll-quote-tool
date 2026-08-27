import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase + displayId modules the same way displayId.test.ts does:
// controllable refs the test swaps per-case.
const { sbRef, allocRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  allocRef: { current: vi.fn(async () => 1000) as (seq: string) => Promise<number> },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

vi.mock('./displayId', () => ({
  allocateNumber: (seq: string) => allocRef.current(seq),
}));

import {
  createJobFromQuote,
  getJob,
  getJobByQuote,
  getJobDetail,
  listJobs,
  listJobsForAdmin,
  listJobsForCustomer,
  mergeJobsNewestFirst,
  setJobStatus,
  type JobRow,
} from './jobs';
import { buildQuoteInputs, initialFormData } from './quoteForm';
import { makeDefaultPermanentFields } from './permanent/types';

// ── A tiny per-table fake Supabase ──────────────────────────────────────────
// Records every insert/update payload and serves canned reads per table. Each
// terminal (.single / .maybeSingle / awaiting the builder) resolves the row(s)
// configured for whichever table .from() was called with.
type TableData = {
  read?: Record<string, unknown> | null; // for .single()/.maybeSingle()
  list?: Record<string, unknown>[]; // for awaited list reads
};
function makeSb(tables: Record<string, TableData>) {
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const updates: Record<string, Record<string, unknown>[]> = {};
  let table = '';
  let mode: 'read' | 'insert' | 'update' = 'read';

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: (t: string) => {
      table = t;
      mode = 'read';
      return builder;
    },
    select: () => builder,
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      (inserts[table] ??= []).push(payload);
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      (updates[table] ??= []).push(payload);
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => {
      if (mode === 'insert' || mode === 'update') {
        const arr = (mode === 'insert' ? inserts : updates)[table] ?? [];
        return { data: { id: 'job-new', ...arr[arr.length - 1] }, error: null };
      }
      return { data: tables[table]?.read ?? null, error: null };
    },
    maybeSingle: async () => ({ data: tables[table]?.read ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: tables[table]?.list ?? [], error: null });
    },
  });
  return { client: builder, inserts, updates };
}

const QUOTE = {
  id: 'quote-1',
  service_type: 'holiday',
  inputs: buildQuoteInputs({
    ...initialFormData,
    santasFootage: 1,
    santasDifficulty: 'easy',
  }),
  result: { lineItems: [{ label: 'Roofline', amount: 1200 }], total: 2700 },
};

beforeEach(() => {
  sbRef.current = null;
  allocRef.current = vi.fn(async () => 1000);
});

describe('createJobFromQuote', () => {
  it('snapshots line_items, links quote + design, sets type/status, allocates a number', async () => {
    const { client, inserts } = makeSb({
      jobs: { read: null }, // no existing job for the quote
      quotes: { read: QUOTE },
      designs: { read: { id: 'design-7' } },
    });
    sbRef.current = client;

    const job = await createJobFromQuote('quote-1');

    expect(allocRef.current).toHaveBeenCalledWith('job_number_seq');
    expect(inserts.jobs).toHaveLength(1);
    const payload = inserts.jobs[0];
    expect(payload).toMatchObject({
      quote_id: 'quote-1',
      design_id: 'design-7',
      type: 'one_off',
      status: 'to_schedule',
      job_number: 1000,
      line_items: [{ label: 'Roofline', amount: 1200 }],
      budgeted_hours: 0.1,
      labor_revenue_cents: 264,
      rates_are_placeholder: true,
    });
    // fulfillment_stage is the #82 axis — left unset (NULL) by the billing creator.
    expect(payload.fulfillment_stage ?? null).toBeNull();
    expect(job).not.toBeNull();
  });

  it('is idempotent — no-op when a job already exists for the quote', async () => {
    const existing = { id: 'job-existing', quote_id: 'quote-1', status: 'to_schedule' };
    const { client, inserts } = makeSb({
      jobs: { read: existing },
      quotes: { read: QUOTE },
      designs: { read: { id: 'design-7' } },
    });
    sbRef.current = client;

    const job = await createJobFromQuote('quote-1');

    expect(inserts.jobs).toBeUndefined(); // never inserted a second job
    expect(allocRef.current).not.toHaveBeenCalled();
    expect(job).toMatchObject({ id: 'job-existing' });
  });

  it('maps a permanent service_type to a permanent job type', async () => {
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: {
        read: {
          ...QUOTE,
          service_type: 'permanent',
          inputs: buildQuoteInputs({
            ...initialFormData,
            serviceType: 'permanent',
            permanent: { ...makeDefaultPermanentFields(), frontFootage: 70 },
          }),
        },
      },
      designs: { read: null },
    });
    sbRef.current = client;

    await createJobFromQuote('quote-1');
    expect(inserts.jobs[0]).toMatchObject({ type: 'permanent', design_id: null });
  });

  it('logs a warning and still creates the job when the saved geometry block is missing for the service type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: {
        read: {
          ...QUOTE,
          service_type: 'permanent',
          inputs: buildQuoteInputs(initialFormData),
        },
      },
      designs: { read: null },
    });
    sbRef.current = client;

    try {
      const job = await createJobFromQuote('quote-1');

      expect(job).not.toBeNull();
      expect(inserts.jobs[0]).toMatchObject({
        budgeted_hours: null,
        labor_revenue_cents: null,
        // No estimate was computed at all (missing geometry), so nothing here
        // is a "placeholder rate" needing a future recompute — it needs a
        // full re-estimate instead. S57 fix: this used to hard-code `true`
        // regardless, which would have wrongly swept this job into any future
        // rate-recompute query alongside jobs that genuinely used placeholder
        // rates.
        rates_are_placeholder: false,
      });
      expect(warn).toHaveBeenCalledWith(
        'createJobFromQuote: budgeted-hours estimate skipped for quote quote-1 (service_type=permanent).',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('carries the quote customer_id/property_id onto the job (Phase 5 linkage)', async () => {
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: { read: { ...QUOTE, customer_id: 'cust-9', property_id: 'prop-3' } },
      designs: { read: null },
    });
    sbRef.current = client;

    await createJobFromQuote('quote-1');
    expect(inserts.jobs[0]).toMatchObject({ customer_id: 'cust-9', property_id: 'prop-3' });
  });

  it('leaves customer linkage null when the quote is not yet linked', async () => {
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: { read: QUOTE }, // no customer_id/property_id on the quote
      designs: { read: null },
    });
    sbRef.current = client;

    await createJobFromQuote('quote-1');
    expect(inserts.jobs[0]).toMatchObject({ customer_id: null, property_id: null });
  });

  it('recovers the existing job when a concurrent insert hits the unique index (23505)', async () => {
    // Race: the idempotency guard sees no job, the insert loses to the winner's
    // partial-unique-index, and the creator converges on the winner instead of
    // returning a spurious null.
    const winner = { id: 'job-win', quote_id: 'quote-1', status: 'to_schedule' };
    let jobsRead = 0;
    let table = '';
    let mode: 'read' | 'insert' = 'read';
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      from: (t: string) => {
        table = t;
        mode = 'read';
        return builder;
      },
      select: () => builder,
      insert: () => {
        mode = 'insert';
        return builder;
      },
      eq: () => builder,
      maybeSingle: async () => {
        if (table === 'jobs') {
          jobsRead += 1;
          return { data: jobsRead === 1 ? null : winner, error: null }; // null first (guard), winner on recovery
        }
        if (table === 'quotes') return { data: QUOTE, error: null };
        return { data: null, error: null };
      },
      single: async () =>
        mode === 'insert'
          ? { data: null, error: { code: '23505', message: 'duplicate key' } }
          : { data: null, error: null },
    });
    sbRef.current = builder;

    const job = await createJobFromQuote('quote-1');
    expect(job).toMatchObject({ id: 'job-win' });
  });

  it('returns null when the quote does not exist', async () => {
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: { read: null },
      designs: { read: null },
    });
    sbRef.current = client;

    const job = await createJobFromQuote('missing');
    expect(job).toBeNull();
    expect(inserts.jobs).toBeUndefined();
  });

  it('still creates the job when the job_number allocation fails', async () => {
    allocRef.current = vi.fn(async () => {
      throw new Error('sequence missing');
    });
    const { client, inserts } = makeSb({
      jobs: { read: null },
      quotes: { read: QUOTE },
      designs: { read: null },
    });
    sbRef.current = client;

    const job = await createJobFromQuote('quote-1');
    expect(job).not.toBeNull();
    expect(inserts.jobs).toHaveLength(1);
    expect('job_number' in inserts.jobs[0]).toBe(false); // key omitted on failure
  });

  it('returns null when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await createJobFromQuote('quote-1')).toBeNull();
  });
});

describe('getJob / getJobByQuote / listJobs', () => {
  it('getJob reads a single job by id', async () => {
    const { client } = makeSb({ jobs: { read: { id: 'job-1', status: 'scheduled' } } });
    sbRef.current = client;
    expect(await getJob('job-1')).toMatchObject({ id: 'job-1', status: 'scheduled' });
  });

  it('getJobByQuote reads the job linked to a quote', async () => {
    const { client } = makeSb({ jobs: { read: { id: 'job-1', quote_id: 'quote-1' } } });
    sbRef.current = client;
    expect(await getJobByQuote('quote-1')).toMatchObject({ quote_id: 'quote-1' });
  });

  it('listJobs returns the rows', async () => {
    const { client } = makeSb({ jobs: { list: [{ id: 'a' }, { id: 'b' }] } });
    sbRef.current = client;
    const jobs = await listJobs();
    expect(jobs).toHaveLength(2);
  });
});

describe('setJobStatus', () => {
  it('applies a legal transition', async () => {
    const { client, updates } = makeSb({
      jobs: { read: { id: 'job-1', status: 'to_schedule' } },
    });
    sbRef.current = client;

    const ok = await setJobStatus('job-1', 'scheduled');
    expect(ok).not.toBeNull();
    expect(updates.jobs[0]).toMatchObject({ status: 'scheduled' });
  });

  it('stamps completed_at when moving to done', async () => {
    const { client, updates } = makeSb({
      jobs: { read: { id: 'job-1', status: 'requires_invoicing' } },
    });
    sbRef.current = client;

    await setJobStatus('job-1', 'done');
    expect(updates.jobs[0].status).toBe('done');
    expect(updates.jobs[0].completed_at).toBeTruthy();
  });

  it('throws on an illegal transition and does not write', async () => {
    const { client, updates } = makeSb({
      jobs: { read: { id: 'job-1', status: 'to_schedule' } },
    });
    sbRef.current = client;

    await expect(setJobStatus('job-1', 'done')).rejects.toThrow(/transition/i);
    expect(updates.jobs).toBeUndefined();
  });

  it('returns null when the job does not exist', async () => {
    const { client } = makeSb({ jobs: { read: null } });
    sbRef.current = client;
    expect(await setJobStatus('missing', 'scheduled')).toBeNull();
  });

  // W1-023: optimistic lock — the UPDATE carries `.eq('status', current.status)`,
  // so a concurrent transition that moved the row out from under our read matches
  // 0 rows. We must NOT write the requested status over the winner's; a divergent
  // race returns null (lost race), not a bogus success.
  it('does NOT write over a concurrently-changed status (compare-and-swap)', async () => {
    // Read sees requires_invoicing (a legal → done), but the row has since been
    // cancelled by a concurrent request. The status guard must match 0 rows.
    const staleRead = { id: 'job-1', status: 'requires_invoicing' };
    const liveRow = { id: 'job-1', status: 'cancelled' };
    let statusGuard: unknown = undefined;
    let updatePatch: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      from: () => builder,
      select: () => builder,
      update: (patch: Record<string, unknown>) => {
        updatePatch = patch;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        if (col === 'status') statusGuard = val;
        return builder;
      },
      // getJob pre-check → the STALE snapshot.
      maybeSingle: async () => ({ data: staleRead, error: null }),
      // The guarded write uses .select(JOB_SELECT).single(). Honor the status
      // guard against the LIVE row: mismatch → PGRST116-style no-rows error.
      single: async () => {
        if (statusGuard !== undefined && statusGuard !== liveRow.status) {
          return { data: null, error: { message: 'no rows' } };
        }
        return { data: { ...liveRow, ...updatePatch }, error: null };
      },
    };
    sbRef.current = builder;
    // Read (requires_invoicing) allows the transition to done; the compare-and-swap
    // against the LIVE (cancelled) row fails → 0 rows → null, never a false 'done'.
    const result = await setJobStatus('job-1', 'done');
    expect(statusGuard).toBe('requires_invoicing'); // guarded on the read status
    expect(result).toBeNull();
  });
});

describe('listJobsForAdmin', () => {
  it('joins customer identity + is_test from the linked quote (all statuses)', async () => {
    const { client } = makeSb({
      jobs: {
        list: [
          {
            id: 'j1',
            job_number: 1001,
            quote_id: 'q1',
            status: 'requires_invoicing',
            type: 'one_off',
            install_date: null,
            created_at: '2026-06-01',
            line_items: [{ label: 'Roofline', amount: 1200 }],
          },
          {
            id: 'j2',
            job_number: 1002,
            quote_id: 'q2',
            status: 'to_schedule',
            type: 'one_off',
            install_date: '2026-12-01',
            created_at: '2026-06-02',
            line_items: [],
          },
        ],
      },
      quotes: {
        list: [
          { id: 'q1', customer_name: 'Alice', customer_address: '1 Main St', is_test: false },
          { id: 'q2', customer_name: 'Test Bob', customer_address: '2 Oak', is_test: true },
        ],
      },
    });
    sbRef.current = client;

    const cards = await listJobsForAdmin();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      id: 'j1',
      jobNumber: 1001,
      quoteId: 'q1',
      status: 'requires_invoicing',
      type: 'one_off',
      customerName: 'Alice',
      customerAddress: '1 Main St',
      isTest: false,
      itemCount: 1,
    });
    expect(cards[1]).toMatchObject({
      id: 'j2',
      customerName: 'Test Bob',
      isTest: true,
      itemCount: 0,
    });
    // WT-19: JobAdminCard no longer carries installDate (nothing ever writes
    // install_date, so the admin list's Install column was always "—").
    expect(cards[1]).not.toHaveProperty('installDate');
  });

  it('nulls customer identity when a job has no linked quote', async () => {
    const { client } = makeSb({
      jobs: {
        list: [
          {
            id: 'j1',
            job_number: null,
            quote_id: null,
            status: 'to_schedule',
            type: 'one_off',
            install_date: null,
            created_at: '2026-06-01',
            line_items: null,
          },
        ],
      },
    });
    sbRef.current = client;

    const cards = await listJobsForAdmin();
    expect(cards[0]).toMatchObject({ id: 'j1', customerName: null, isTest: false, itemCount: 0 });
  });

  it('returns [] when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listJobsForAdmin()).toEqual([]);
  });

  it('computes the customer-detail route id fields (highlevel_contact_id first, then the job\'s own customer_id over the quote\'s)', async () => {
    const { client } = makeSb({
      jobs: {
        list: [
          { id: 'j1', job_number: 1001, quote_id: 'q1', customer_id: null, status: 'to_schedule', type: 'one_off', install_date: null, created_at: '2026-06-01', line_items: [] },
          { id: 'j2', job_number: 1002, quote_id: 'q2', customer_id: 'job-cust-2', status: 'to_schedule', type: 'one_off', install_date: null, created_at: '2026-06-02', line_items: [] },
        ],
      },
      quotes: {
        list: [
          { id: 'q1', customer_name: 'Alice', customer_address: '1 Main St', is_test: false, highlevel_contact_id: 'hl-1', customer_id: 'quote-cust-1' },
          { id: 'q2', customer_name: 'Bob', customer_address: '2 Oak', is_test: false, highlevel_contact_id: null, customer_id: 'quote-cust-2' },
        ],
      },
    });
    sbRef.current = client;

    const cards = await listJobsForAdmin();
    // j1: no job.customer_id, but the quote has a highlevel_contact_id — wins.
    expect(cards[0]).toMatchObject({ id: 'j1', highlevelContactId: 'hl-1', customerId: 'quote-cust-1' });
    // j2: no highlevel_contact_id on the quote — the job's OWN customer_id
    // ('job-cust-2') is preferred over the quote's ('quote-cust-2').
    expect(cards[1]).toMatchObject({ id: 'j2', highlevelContactId: null, customerId: 'job-cust-2' });
  });

  // #199: is_nce joins the same way is_test does above — feeds the NceBadge.
  it('joins is_nce from the linked quote', async () => {
    const { client } = makeSb({
      jobs: {
        list: [
          { id: 'j1', job_number: 1001, quote_id: 'q1', status: 'to_schedule', type: 'one_off', install_date: null, created_at: '2026-06-01', line_items: [] },
          { id: 'j2', job_number: 1002, quote_id: 'q2', status: 'to_schedule', type: 'one_off', install_date: null, created_at: '2026-06-02', line_items: [] },
        ],
      },
      quotes: {
        list: [
          { id: 'q1', customer_name: 'Alice', is_test: false, is_nce: true },
          { id: 'q2', customer_name: 'Bob', is_test: false, is_nce: false },
        ],
      },
    });
    sbRef.current = client;

    const cards = await listJobsForAdmin();
    expect(cards[0]).toMatchObject({ id: 'j1', isNce: true });
    expect(cards[1]).toMatchObject({ id: 'j2', isNce: false });
  });

  it('defaults isNce to false when a job has no linked quote', async () => {
    const { client } = makeSb({
      jobs: { list: [{ id: 'j1', job_number: null, quote_id: null, status: 'to_schedule', type: 'one_off', install_date: null, created_at: '2026-06-01', line_items: null }] },
    });
    sbRef.current = client;
    const cards = await listJobsForAdmin();
    expect(cards[0].isNce).toBe(false);
  });
});

describe('getJobDetail', () => {
  it('returns the job with joined customer + the linked invoice', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'requires_invoicing', line_items: [] } },
      quotes: {
        read: {
          customer_name: 'Alice',
          customer_email: 'a@x.com',
          customer_phone: '555-0100',
          customer_address: '1 Main St',
          is_test: false,
        },
      },
      invoices: { read: { id: 'inv1', balance: 500, status: 'draft' } },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail).toMatchObject({
      job: { id: 'j1' },
      customerName: 'Alice',
      customerEmail: 'a@x.com',
      customerPhone: '555-0100',
      isTest: false,
      invoice: { id: 'inv1', balance: 500 },
    });
  });

  // Row 418: the customer-name link on /admin/jobs/[id] routes by this field —
  // HL contact id first, then the job's own customer_id, then the quote's.
  it('resolves customerRouteId with the HL contact id winning over both customer_ids', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', customer_id: 'job-cust', status: 'requires_invoicing', line_items: [] } },
      quotes: { read: { customer_name: 'Alice', highlevel_contact_id: 'hl-1', customer_id: 'quote-cust' } },
      invoices: { read: null },
    });
    sbRef.current = client;
    expect((await getJobDetail('j1'))?.customerRouteId).toBe('hl-1');
  });

  it('falls back to the job\'s own customer_id, then the quote\'s, then null (plain-text walk-in)', async () => {
    const base = { quote_id: 'q1', status: 'requires_invoicing', line_items: [] };
    {
      const { client } = makeSb({
        jobs: { read: { id: 'j1', customer_id: 'job-cust', ...base } },
        quotes: { read: { customer_name: 'Alice', highlevel_contact_id: null, customer_id: 'quote-cust' } },
        invoices: { read: null },
      });
      sbRef.current = client;
      expect((await getJobDetail('j1'))?.customerRouteId).toBe('job-cust');
    }
    {
      const { client } = makeSb({
        jobs: { read: { id: 'j1', customer_id: null, ...base } },
        quotes: { read: { customer_name: 'Alice', highlevel_contact_id: null, customer_id: 'quote-cust' } },
        invoices: { read: null },
      });
      sbRef.current = client;
      expect((await getJobDetail('j1'))?.customerRouteId).toBe('quote-cust');
    }
    {
      const { client } = makeSb({
        jobs: { read: { id: 'j1', customer_id: null, ...base } },
        quotes: { read: { customer_name: 'Walk In', highlevel_contact_id: null, customer_id: null } },
        invoices: { read: null },
      });
      sbRef.current = client;
      expect((await getJobDetail('j1'))?.customerRouteId).toBeNull();
    }
  });

  it('carries the labor numbers in tagged form, flagged when the rates are placeholder', async () => {
    // GET /api/jobs/[id] serializes this object wholesale to consumers outside
    // this repo, where the lint guardrail cannot reach. The tagged plan is what
    // stops a placeholder figure arriving there looking measured.
    const { client } = makeSb({
      jobs: {
        read: {
          id: 'j1',
          quote_id: 'q1',
          status: 'to_schedule',
          budgeted_hours: 12.5,
          labor_revenue_cents: 26400,
          rates_are_placeholder: true,
        },
      },
      quotes: { read: { customer_name: 'Dana' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.laborPlan).toMatchObject({
      status: 'placeholder',
      budgetedHours: 12.5,
      laborRevenueCents: 26400,
    });
  });

  it('tags the labor plan as real once the placeholder flag is cleared', async () => {
    const { client } = makeSb({
      jobs: {
        read: {
          id: 'j1',
          quote_id: 'q1',
          status: 'to_schedule',
          budgeted_hours: 8,
          labor_revenue_cents: 10000,
          rates_are_placeholder: false,
        },
      },
      quotes: { read: { customer_name: 'Dana' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    expect((await getJobDetail('j1'))?.laborPlan).toEqual({
      status: 'real',
      budgetedHours: 8,
      laborRevenueCents: 10000,
    });
  });

  it('returns a null invoice (and carries is_test) when no invoice exists yet', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule' } },
      quotes: { read: { customer_name: 'Bob', is_test: true } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.invoice).toBeNull();
    expect(detail?.isTest).toBe(true);
  });

  it('carries the linked quote service_type (#117 — a one_off job can be Bistro, not just Seasonal)', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule', type: 'one_off' } },
      quotes: { read: { customer_name: 'Carol', service_type: 'permanent_bistro' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.quoteServiceType).toBe('permanent_bistro');
  });

  // #177 fix 4: the linked quote's stamped deposit_amount_usd, so the jobs detail
  // page can pass it to reconcileInvoice as the intended deposit.
  it('carries the linked quote\'s deposit_amount_usd as intendedDepositUsd', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule' } },
      quotes: { read: { customer_name: 'Dana', deposit_amount_usd: 800 } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.intendedDepositUsd).toBe(800);
  });

  // #199: is_nce joins the same way is_test does — drives the NceBadge on
  // the job detail header.
  it('surfaces the linked quote\'s is_nce', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule' } },
      quotes: { read: { customer_name: 'Erin', is_nce: true } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.isNce).toBe(true);
  });

  it('defaults isNce to false when the job has no linked quote', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: null, status: 'to_schedule' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.isNce).toBe(false);
  });

  // Ledger #83 follow-up (a real live incident): the job page previously had
  // NO visibility into the amendment trail at all — a customer could decline
  // a price change and the operator on THIS page would never know.
  it('carries the linked quote\'s amendment trail, including a declined entry', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule' } },
      quotes: {
        read: {
          customer_name: 'Frank',
          approval_snapshot: {
            amendments: [
              {
                amended_at: '2026-08-18T12:00:00.000Z',
                by: 'staff:ops',
                reason: 'Added a wreath',
                previous_total: 1428.16,
                new_total: 1770.72,
                previous_balance: 714.08,
                new_balance: 1056.64,
                deposit_applied: 714.08,
                delta: 342.56,
                line_item_changes: [],
                consent: { status: 'declined', declined_at: '2026-08-19T09:00:00.000Z', ip: null },
              },
            ],
          },
        },
      },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.amendments).toHaveLength(1);
    expect(detail?.amendments[0].consent).toMatchObject({ status: 'declined' });
  });

  it('defaults amendments to an empty array when the quote has never been amended', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: 'q1', status: 'to_schedule' } },
      quotes: { read: { customer_name: 'Grace' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.amendments).toEqual([]);
  });

  it('defaults amendments to an empty array when the job has no linked quote', async () => {
    const { client } = makeSb({
      jobs: { read: { id: 'j1', quote_id: null, status: 'to_schedule' } },
      invoices: { read: null },
    });
    sbRef.current = client;

    const detail = await getJobDetail('j1');
    expect(detail?.amendments).toEqual([]);
  });

  it('returns null when the job does not exist', async () => {
    const { client } = makeSb({ jobs: { read: null } });
    sbRef.current = client;
    expect(await getJobDetail('missing')).toBeNull();
  });

  it('returns null when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await getJobDetail('j1')).toBeNull();
  });
});

// ─── mergeJobsNewestFirst (PURE — customer detail page match, #58) ─────────

describe('mergeJobsNewestFirst', () => {
  const job = (id: string, created_at: string, extra: Record<string, unknown> = {}): JobRow =>
    ({ id, created_at, ...extra }) as unknown as JobRow;

  it('de-duplicates rows that appear in more than one input list, newest-first', () => {
    const a = job('j1', '2026-06-01');
    const b = job('j2', '2026-06-05');
    const aAgain = job('j1', '2026-06-01'); // e.g. matched by BOTH customer_id and quote_id
    const merged = mergeJobsNewestFirst([a, b], [aAgain, b]);
    expect(merged.map((j) => j.id)).toEqual(['j2', 'j1']);
    expect(merged).toHaveLength(2);
  });

  it('returns [] for no lists or all-empty lists', () => {
    expect(mergeJobsNewestFirst()).toEqual([]);
    expect(mergeJobsNewestFirst([], [])).toEqual([]);
  });

  it('a later list wins on a same-id collision (last-write-wins)', () => {
    const stale = job('j1', '2026-06-01', { status: 'to_schedule' });
    const fresh = job('j1', '2026-06-01', { status: 'done' });
    const merged = mergeJobsNewestFirst([stale], [fresh]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'j1', status: 'done' });
  });
});

describe('listJobsForCustomer', () => {
  // Purpose-built fake with REAL .eq()/.in() column filtering (the shared makeSb
  // fake ignores filters, which can't prove customer scoping — mirrors the
  // filtering fake invoices.test.ts uses for its listInvoicesForCustomer test).
  function makeFilteringJobsDb(rows: Record<string, unknown>[]) {
    return {
      from: (table: string) => {
        if (table !== 'jobs') throw new Error('unexpected table ' + table);
        return {
          select: () => ({
            eq: async (col: string, val: unknown) => ({
              data: rows.filter((r) => r[col] === val),
              error: null,
            }),
            in: async (col: string, vals: unknown[]) => ({
              data: rows.filter((r) => vals.includes(r[col])),
              error: null,
            }),
          }),
        };
      },
    };
  }

  it('merges the customer_id match and the quote_id match, de-duplicated newest-first, excluding other customers', async () => {
    sbRef.current = makeFilteringJobsDb([
      { id: 'j1', quote_id: 'q1', customer_id: 'cust-1', created_at: '2026-06-01' },
      { id: 'j2', quote_id: 'q2', customer_id: null, created_at: '2026-06-05' },
      // Another customer's job — matches NEITHER cust-1 nor the quote-id set;
      // must never leak into this customer's list.
      { id: 'j3', quote_id: 'q-other', customer_id: 'cust-2', created_at: '2026-06-09' },
    ]);

    const jobs = await listJobsForCustomer('cust-1', ['q1', 'q2']);
    expect(jobs.map((j) => j.id)).toEqual(['j2', 'j1']);
    expect(jobs.some((j) => j.id === 'j3')).toBe(false);
  });

  it('returns [] when neither a customerId nor any quoteIds are given', async () => {
    const { client } = makeSb({ jobs: { list: [] } });
    sbRef.current = client;
    expect(await listJobsForCustomer(null, [])).toEqual([]);
  });

  it('returns [] when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listJobsForCustomer('cust-1', ['q1'])).toEqual([]);
  });
});
