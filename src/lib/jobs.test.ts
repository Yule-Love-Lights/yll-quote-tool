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

import { createJobFromQuote, getJob, getJobByQuote, listJobs, setJobStatus } from './jobs';

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
      quotes: { read: { ...QUOTE, service_type: 'permanent' } },
      designs: { read: null },
    });
    sbRef.current = client;

    await createJobFromQuote('quote-1');
    expect(inserts.jobs[0]).toMatchObject({ type: 'permanent', design_id: null });
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
});
