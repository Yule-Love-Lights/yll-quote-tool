import { beforeEach, describe, expect, it, vi } from 'vitest';

// Money/state tests for the advertising placements data layer. Written
// FIRST, against Naldo's rulings (2026-08-27, pay basis updated
// 2026-08-29): the campaign rate is paid per ACCEPTED PHOTO of any kind,
// stamped at acceptance; rate changes never move history; pending/rejected
// never pay; reject→resubmit→accept pays exactly once.

type AnyRow = Record<string, unknown>;
type DbError = { code?: string; message: string };

type Filter =
  | { kind: 'eq' | 'is'; col: string; val: unknown }
  | { kind: 'in'; col: string; vals: unknown[] };

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      tables: {
        advertising_workers: [] as AnyRow[],
        advertising_campaigns: [] as AnyRow[],
        advertising_placements: [] as AnyRow[],
        advertising_activity: [] as AnyRow[],
      } as Record<string, AnyRow[]>,
      updates: [] as { table: string; payload: AnyRow }[],
      inserted: [] as { table: string; payload: AnyRow }[],
      selectError: null as DbError | null,
      insertError: null as DbError | null,
      // When set, the NEXT single-row select returns this snapshot instead of
      // the live row, then clears — models a stale read racing a concurrent
      // writer, so the CAS guards can actually be exercised.
      staleReadOnce: null as AnyRow | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function rowMatches(row: AnyRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === 'in') return f.vals.includes(row[f.col]);
    return row[f.col] === f.val;
  });
}

function makeDb() {
  return {
    from(table: string) {
      const rows = () => stateRef.current.tables[table];
      return {
        select(_cols?: string) {
          const filters: Filter[] = [];
          const b = {
            eq(col: string, val: unknown) {
              filters.push({ kind: 'eq', col, val });
              return b;
            },
            in(col: string, vals: unknown[]) {
              filters.push({ kind: 'in', col, vals });
              return b;
            },
            is(col: string, val: unknown) {
              filters.push({ kind: 'is', col, val });
              return b;
            },
            maybeSingle() {
              if (stateRef.current.selectError) {
                return Promise.resolve({ data: null, error: stateRef.current.selectError });
              }
              if (stateRef.current.staleReadOnce) {
                const stale = stateRef.current.staleReadOnce;
                stateRef.current.staleReadOnce = null;
                return Promise.resolve({ data: stale, error: null });
              }
              const found = rows().filter((r) => rowMatches(r, filters));
              return Promise.resolve({ data: found[0] ?? null, error: null });
            },
            order(col: string, opts?: { ascending?: boolean }) {
              const sortKeys: Array<{ col: string; asc: boolean }> = [
                { col, asc: opts?.ascending !== false },
              ];
              const sorted = () => {
                const list = rows().filter((r) => rowMatches(r, filters));
                return [...list].sort((a, b) => {
                  for (const k of sortKeys) {
                    const av = String(a[k.col] ?? '');
                    const bv = String(b[k.col] ?? '');
                    const cmp = k.asc ? av.localeCompare(bv) : bv.localeCompare(av);
                    if (cmp !== 0) return cmp;
                  }
                  return 0;
                });
              };
              const ob = {
                order(col2: string, opts2?: { ascending?: boolean }) {
                  sortKeys.push({ col: col2, asc: opts2?.ascending !== false });
                  return ob;
                },
                range(from: number, to: number) {
                  if (stateRef.current.selectError) {
                    return Promise.resolve({ data: null, error: stateRef.current.selectError });
                  }
                  return Promise.resolve({ data: sorted().slice(from, to + 1), error: null });
                },
                // Awaiting without .range() models PostgREST's silent
                // 1000-row default cap — the trap the paging exists to dodge.
                then(
                  resolve: (v: { data: AnyRow[] | null; error: DbError | null }) => void,
                  reject?: (e: unknown) => void,
                ) {
                  if (stateRef.current.selectError) {
                    return Promise.resolve({ data: null, error: stateRef.current.selectError }).then(resolve, reject);
                  }
                  return Promise.resolve({ data: sorted().slice(0, 1000), error: null }).then(resolve, reject);
                },
              };
              return ob;
            },
          };
          return b;
        },
        insert(payload: AnyRow) {
          const err = stateRef.current.insertError;
          let row: AnyRow | null = null;
          if (!err) {
            // A real insert returns every column (unset ones as null); the
            // mock mirrors that so toPlacement sees the same shape.
            const nullDefaults: AnyRow =
              table === 'advertising_placements'
                ? {
                    accuracy_m: null,
                    captured_at: null,
                    suggested_address: null,
                    route: null,
                    neighborhood: null,
                    property_id: null,
                    rejection_reason: null,
                    accepted_rate_cents: null,
                    reviewed_by: null,
                    reviewed_at: null,
                    is_test: false,
                  }
                : {};
            row = {
              id: `${table}-${rows().length + 1}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...nullDefaults,
              ...payload,
            };
            rows().push(row);
            stateRef.current.inserted.push({ table, payload });
          }
          const p = Promise.resolve({ data: null, error: err }) as Promise<{
            data: null;
            error: DbError | null;
          }> & { select: (cols?: string) => { maybeSingle: () => Promise<{ data: AnyRow | null; error: DbError | null }> } };
          p.select = () => ({
            maybeSingle: () => Promise.resolve({ data: err ? null : row, error: err }),
          });
          return p;
        },
        update(payload: AnyRow) {
          const filters: Filter[] = [];
          const ub = {
            eq(col: string, val: unknown) {
              filters.push({ kind: 'eq', col, val });
              return ub;
            },
            in(col: string, vals: unknown[]) {
              filters.push({ kind: 'in', col, vals });
              return ub;
            },
            is(col: string, val: unknown) {
              filters.push({ kind: 'is', col, val });
              return ub;
            },
            select(_cols?: string) {
              return {
                maybeSingle: () => {
                  const idx = rows().findIndex((r) => rowMatches(r, filters));
                  if (idx === -1) return Promise.resolve({ data: null, error: null });
                  stateRef.current.updates.push({ table, payload });
                  rows()[idx] = { ...rows()[idx], ...payload, updated_at: new Date().toISOString() };
                  return Promise.resolve({ data: rows()[idx], error: null });
                },
              };
            },
          };
          return ub;
        },
      };
    },
  };
}

let seq = 0;

function seedWorker(overrides: AnyRow = {}): AnyRow {
  const row: AnyRow = {
    id: `worker-${++seq}`,
    display_name: `Worker ${seq}`,
    auth_user_id: null,
    active: true,
    is_test: false,
    created_at: '2026-08-20T12:00:00.000Z',
    updated_at: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
  stateRef.current.tables.advertising_workers.push(row);
  return row;
}

function seedCampaign(overrides: AnyRow = {}): AnyRow {
  const row: AnyRow = {
    id: `campaign-${++seq}`,
    name: `Campaign ${seq}`,
    notes: null,
    rate_cents: 250,
    active: true,
    is_test: false,
    created_at: '2026-08-20T12:00:00.000Z',
    updated_at: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
  stateRef.current.tables.advertising_campaigns.push(row);
  return row;
}

function seedPlacement(overrides: AnyRow = {}): AnyRow {
  const row: AnyRow = {
    id: `placement-${++seq}`,
    campaign_id: 'campaign-none',
    worker_id: 'worker-none',
    kind: 'yard_sign',
    status: 'pending',
    lat: 40.75,
    lng: -73.4,
    accuracy_m: 8,
    captured_at: '2026-08-24T15:00:00.000Z',
    photo_path: `proof/${seq}.jpg`,
    suggested_address: null,
    route: null,
    neighborhood: null,
    property_id: null,
    rejection_reason: null,
    accepted_rate_cents: null,
    reviewed_by: null,
    reviewed_at: null,
    is_test: false,
    created_at: '2026-08-24T15:00:00.000Z',
    updated_at: '2026-08-24T15:00:00.000Z',
    ...overrides,
  };
  stateRef.current.tables.advertising_placements.push(row);
  return row;
}

function placementUpdates(): AnyRow[] {
  return stateRef.current.updates
    .filter((u) => u.table === 'advertising_placements')
    .map((u) => u.payload);
}

beforeEach(() => {
  stateRef.current.tables.advertising_workers = [];
  stateRef.current.tables.advertising_campaigns = [];
  stateRef.current.tables.advertising_placements = [];
  stateRef.current.tables.advertising_activity = [];
  stateRef.current.updates = [];
  stateRef.current.inserted = [];
  stateRef.current.selectError = null;
  stateRef.current.insertError = null;
  stateRef.current.staleReadOnce = null;
  dbRef.current = makeDb();
});

const REVIEWER = '00000000-0000-0000-0000-00000000adad';

describe('acceptPlacement', () => {
  it('stamps the campaign rate in integer cents onto a yard sign at acceptance', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    const accepted = await acceptPlacement(String(p.id), REVIEWER);

    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedRateCents).toBe(250);
    expect(accepted.reviewedBy).toBe(REVIEWER);
    expect(accepted.reviewedAt).toBeTruthy();
  });

  it('a campaign rate change after acceptance never moves the stamped rate', async () => {
    const { acceptPlacement, getPlacement } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    await acceptPlacement(String(p.id), REVIEWER);
    campaign.rate_cents = 300; // rate change AFTER acceptance

    const row = await getPlacement(String(p.id));
    expect(row?.acceptedRateCents).toBe(250);
  });

  it('a retried accept is idempotent: one stamp, one status update, same rate back', async () => {
    const { acceptPlacement, earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    const first = await acceptPlacement(String(p.id), REVIEWER);
    campaign.rate_cents = 300; // a retry after a rate change must NOT re-stamp
    const second = await acceptPlacement(String(p.id), REVIEWER);

    expect(first.acceptedRateCents).toBe(250);
    expect(second.acceptedRateCents).toBe(250);
    const statusWrites = placementUpdates().filter((u) => u.status === 'accepted');
    expect(statusWrites).toHaveLength(1);

    // Earned totals read the STAMP, never a join against the campaign's
    // current rate — with the rate now 300, earned must still be 250.
    const summaries = await earningsSummary();
    expect(summaries.find((s) => s.workerId === worker.id)?.total.acceptedEarnedCents).toBe(250);
  });

  it('reject → resubmit → accept pays exactly once', async () => {
    const { acceptPlacement, rejectPlacement, resubmitPlacement, earningsSummary } = await import(
      './placements'
    );
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    await rejectPlacement(String(p.id), REVIEWER, 'blurry photo');
    await resubmitPlacement(String(p.id));
    await acceptPlacement(String(p.id), REVIEWER);
    // double-submission retry of the same accept
    await acceptPlacement(String(p.id), REVIEWER);

    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.total.acceptedEarnedCents).toBe(250);
    expect(mine?.total.pendingEstimatedCents).toBe(0);
  });

  it('an accepted door hanger stamps the campaign rate too — pay is per accepted PHOTO (Naldo 2026-08-29)', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, kind: 'door_hanger' });

    const accepted = await acceptPlacement(String(p.id), REVIEWER);

    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedRateCents).toBe(250);
  });

  it('refuses to accept a placement with no proof photo (data-layer mirror of the DB CHECK)', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, photo_path: null });

    await expect(acceptPlacement(String(p.id), REVIEWER)).rejects.toThrow(/photo/i);
    expect(placementUpdates()).toHaveLength(0);
  });

  it('a stale concurrent accept cannot re-stamp an already-accepted placement (CAS)', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 300 }); // rate ALREADY moved since the first accept
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    // This reviewer's read predates the other admin's accept: they still see pending.
    stateRef.current.staleReadOnce = { ...p, status: 'pending', accepted_rate_cents: null, reviewed_by: null, reviewed_at: null };

    const result = await acceptPlacement(String(p.id), 'other-admin');

    expect(result.acceptedRateCents).toBe(250); // first stamp survives
    expect(result.reviewedBy).toBe(REVIEWER); // first review survives
    expect(placementUpdates()).toHaveLength(0); // the stale write never landed
  });

  it('a stale accept against a just-rejected placement throws instead of overwriting the review (CAS)', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'rejected',
      rejection_reason: 'wrong spot',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    stateRef.current.staleReadOnce = { ...p, status: 'pending', rejection_reason: null, reviewed_by: null, reviewed_at: null };

    await expect(acceptPlacement(String(p.id), 'other-admin')).rejects.toThrow(/rejected/);
    expect(placementUpdates()).toHaveLength(0);
  });

  it('refuses to accept a rejected placement that has not been resubmitted', async () => {
    const { acceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'rejected',
      rejection_reason: 'wrong spot',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });

    await expect(acceptPlacement(String(p.id), REVIEWER)).rejects.toThrow(/rejected/i);
  });
});

describe('rejectPlacement / resubmitPlacement', () => {
  it('refuses an empty rejection reason (data-layer mirror of the DB CHECK)', async () => {
    const { rejectPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    await expect(rejectPlacement(String(p.id), REVIEWER, '   ')).rejects.toThrow(/reason/i);
    expect(placementUpdates()).toHaveLength(0);
  });

  it('stamps reviewer and reason on reject, and the reason survives resubmission', async () => {
    const { rejectPlacement, resubmitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    const rejected = await rejectPlacement(String(p.id), REVIEWER, 'blurry photo');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('blurry photo');
    expect(rejected.reviewedBy).toBe(REVIEWER);

    const resubmitted = await resubmitPlacement(String(p.id));
    expect(resubmitted.status).toBe('resubmitted');
    expect(resubmitted.rejectionReason).toBe('blurry photo');
  });

  it('resubmit only moves rejected placements', async () => {
    const { resubmitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const pending = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });
    const accepted = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });

    await expect(resubmitPlacement(String(pending.id))).rejects.toThrow();
    await expect(resubmitPlacement(String(accepted.id))).rejects.toThrow();
  });

  it('a stale reject against a just-accepted placement throws instead of overwriting the pay record (CAS)', async () => {
    const { rejectPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    // rejectPlacement goes straight to its CAS write, so the race IS the row
    // already being accepted when this reject arrives.
    await expect(rejectPlacement(String(p.id), 'other-admin', 'too close')).rejects.toThrow(/accepted/);
    expect(placementUpdates()).toHaveLength(0);
  });

  it('a stale resubmit against a just-accepted placement throws instead of reopening it (CAS)', async () => {
    const { resubmitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    // Same shape: the CAS (.eq status 'rejected') must refuse to reopen an
    // accepted pay record however stale the worker's screen was.
    await expect(resubmitPlacement(String(p.id))).rejects.toThrow(/accepted/);
    expect(placementUpdates()).toHaveLength(0);
  });

  it('a retried resubmit is idempotent', async () => {
    const { rejectPlacement, resubmitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id });

    await rejectPlacement(String(p.id), REVIEWER, 'blurry');
    const first = await resubmitPlacement(String(p.id));
    const second = await resubmitPlacement(String(p.id));
    expect(first.status).toBe('resubmitted');
    expect(second.status).toBe('resubmitted');
  });
});

describe('submitPlacement', () => {
  it('requires GPS coordinates and a proof photo path', async () => {
    const { submitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();

    await expect(
      submitPlacement({
        campaignId: String(campaign.id),
        workerId: String(worker.id),
        kind: 'yard_sign',
        lat: 40.75,
        lng: -73.4,
        photoPath: '',
      }),
    ).rejects.toThrow(/photo/i);

    await expect(
      submitPlacement({
        campaignId: String(campaign.id),
        workerId: String(worker.id),
        kind: 'yard_sign',
        lat: Number.NaN,
        lng: -73.4,
        photoPath: 'proof/a.jpg',
      }),
    ).rejects.toThrow(/GPS/i);
  });

  it('creates a pending placement carrying the capture fields', async () => {
    const { submitPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();

    const created = await submitPlacement({
      campaignId: String(campaign.id),
      workerId: String(worker.id),
      kind: 'yard_sign',
      lat: 40.7512,
      lng: -73.4213,
      accuracyM: 6,
      capturedAt: '2026-08-24T15:00:00.000Z',
      photoPath: 'proof/sign1.jpg',
      suggestedAddress: '12 Main St, Farmingdale, NY',
    });

    expect(created.status).toBe('pending');
    expect(created.kind).toBe('yard_sign');
    expect(created.acceptedRateCents).toBeNull();
    expect(created.photoPath).toBe('proof/sign1.jpg');
    expect(created.lat).toBe(40.7512);
  });
});

describe('listPlacements', () => {
  it('returns newest first and honors an explicit limit', async () => {
    const { listPlacements } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const base = { campaign_id: campaign.id, worker_id: worker.id };
    const oldest = seedPlacement({ ...base, created_at: '2026-08-20T10:00:00.000Z' });
    const middle = seedPlacement({ ...base, created_at: '2026-08-22T10:00:00.000Z' });
    const newest = seedPlacement({ ...base, created_at: '2026-08-24T10:00:00.000Z' });

    const two = await listPlacements({ workerId: String(worker.id), limit: 2 });
    expect(two.map((p) => p.id)).toEqual([newest.id, middle.id]);
    expect(two.some((p) => p.id === oldest.id)).toBe(false);
  });
});

describe('ET week keys', () => {
  it('buckets DST-transition instants into the right Monday week', async () => {
    const { etWeekStartKey } = await import('./placements');
    // 2026-11-01T07:00Z is 02:00 EST, just AFTER the fall-back — Sunday Nov 1,
    // week of Monday Oct 26.
    expect(etWeekStartKey(new Date('2026-11-01T07:00:00.000Z'))).toBe('2026-10-26');
    // 2026-03-08T07:30Z is 03:30 EDT, just AFTER the spring-forward — Sunday
    // Mar 8, week of Monday Mar 2.
    expect(etWeekStartKey(new Date('2026-03-08T07:30:00.000Z'))).toBe('2026-03-02');
  });
});

describe('earnings math', () => {
  it('accepted-only pay: pending, resubmitted, rejected and is_test rows contribute nothing to earned cents', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const base = { campaign_id: campaign.id, worker_id: worker.id };
    seedPlacement({
      ...base,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    seedPlacement({ ...base, status: 'pending' });
    seedPlacement({ ...base, status: 'resubmitted', rejection_reason: 'retry' });
    seedPlacement({ ...base, status: 'rejected', rejection_reason: 'no', reviewed_by: REVIEWER, reviewed_at: '2026-08-24T16:00:00.000Z' });
    seedPlacement({
      ...base,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
      is_test: true,
    });

    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.total.acceptedEarnedCents).toBe(250);
  });

  it('pending estimate = pending + resubmitted yard signs times the campaign CURRENT rate', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const base = { campaign_id: campaign.id, worker_id: worker.id };
    seedPlacement({ ...base, status: 'pending' });
    seedPlacement({ ...base, status: 'pending' });
    seedPlacement({ ...base, status: 'pending' });
    seedPlacement({ ...base, status: 'resubmitted', rejection_reason: 'retry' });
    seedPlacement({ ...base, status: 'rejected', rejection_reason: 'no', reviewed_by: REVIEWER, reviewed_at: '2026-08-24T16:00:00.000Z' });

    let summaries = await earningsSummary();
    expect(summaries.find((s) => s.workerId === worker.id)?.total.pendingEstimatedCents).toBe(1000);

    campaign.rate_cents = 300; // estimates FOLLOW the current rate (nothing is stamped yet)
    summaries = await earningsSummary();
    expect(summaries.find((s) => s.workerId === worker.id)?.total.pendingEstimatedCents).toBe(1200);
  });

  it('door hangers earn and estimate exactly like yard signs — the campaign name says what the photo is', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const base = { campaign_id: campaign.id, worker_id: worker.id, kind: 'door_hanger' };
    seedPlacement({ ...base, status: 'pending' });
    seedPlacement({
      ...base,
      status: 'accepted',
      accepted_rate_cents: 250,
      photo_path: 'proof/dh.jpg',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });

    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.total.acceptedEarnedCents).toBe(250);
    expect(mine?.total.pendingEstimatedCents).toBe(250);
  });

  it('groups earned cents by ET day and Monday-start ET week (DST-safe calendar math, capturedAt first)', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const base = { campaign_id: campaign.id, worker_id: worker.id };
    // 2026-08-24T03:30Z is 2026-08-23 23:30 ET — a SUNDAY, week of Mon 2026-08-17.
    seedPlacement({
      ...base,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      captured_at: '2026-08-24T03:30:00.000Z',
      reviewed_at: '2026-08-24T12:00:00.000Z',
    });
    // 2026-08-24T12:00Z is 2026-08-24 08:00 ET — MONDAY, week of Mon 2026-08-24.
    seedPlacement({
      ...base,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      captured_at: '2026-08-24T12:00:00.000Z',
      reviewed_at: '2026-08-24T12:00:00.000Z',
    });
    // Pending sign captured the same Monday: estimated in that day/week bucket.
    seedPlacement({ ...base, status: 'pending', captured_at: '2026-08-24T18:00:00.000Z' });

    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);

    expect(mine?.byDay).toEqual([
      { day: '2026-08-23', pendingEstimatedCents: 0, acceptedEarnedCents: 250 },
      { day: '2026-08-24', pendingEstimatedCents: 250, acceptedEarnedCents: 250 },
    ]);
    expect(mine?.byWeek).toEqual([
      { weekStart: '2026-08-17', pendingEstimatedCents: 0, acceptedEarnedCents: 250 },
      { weekStart: '2026-08-24', pendingEstimatedCents: 250, acceptedEarnedCents: 250 },
    ]);
    expect(mine?.total).toEqual({ pendingEstimatedCents: 250, acceptedEarnedCents: 500 });
  });

  it('totals stay right past the 1000-row PostgREST page cap', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    for (let i = 0; i < 1050; i++) {
      seedPlacement({
        campaign_id: campaign.id,
        worker_id: worker.id,
        status: 'pending',
        created_at: new Date(Date.UTC(2026, 7, 24, 15, 0, 0) + i * 1000).toISOString(),
      });
    }

    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.total.pendingEstimatedCents).toBe(1050 * 250);
  });

  it('earningsSummary can scope to one worker', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const w1 = seedWorker();
    const w2 = seedWorker();
    seedPlacement({
      campaign_id: campaign.id,
      worker_id: w1.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });
    seedPlacement({ campaign_id: campaign.id, worker_id: w2.id, status: 'pending' });

    const summaries = await earningsSummary({ workerId: String(w1.id) });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].workerId).toBe(w1.id);
    expect(summaries[0].total.acceptedEarnedCents).toBe(250);
  });
});

describe('submitAcceptedPlacement (admin bulk upload — lands PAID, so every guard is money)', () => {
  const base = () => {
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    return {
      campaignId: String(campaign.id),
      workerId: String(worker.id),
      kind: 'yard_sign' as const,
      rateCents: 250,
      reviewedBy: REVIEWER,
      photoPath: 'placements/w/bulk.jpg',
    };
  };

  it('inserts directly as accepted with the given rate stamped and the admin as reviewer', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    const p = await submitAcceptedPlacement({ ...base(), lat: 40.75, lng: -73.42 });
    expect(p.status).toBe('accepted');
    expect(p.acceptedRateCents).toBe(250);
    expect(p.reviewedBy).toBe(REVIEWER);
    expect(p.reviewedAt).toBeTruthy();
    const logged = stateRef.current.inserted.filter((i) => i.table === 'advertising_activity');
    expect(logged).toHaveLength(1);
    expect(logged[0].payload.action).toBe('accepted');
  });

  it('GPS is optional: both null stores both null', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    const p = await submitAcceptedPlacement({ ...base(), lat: null, lng: null });
    expect(p.status).toBe('accepted');
    expect(p.lat).toBeNull();
    expect(p.lng).toBeNull();
  });

  it('refuses ONE-SIDED GPS — a lat with no lng is a corrupt location, not a partial one', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    await expect(submitAcceptedPlacement({ ...base(), lat: 40.75, lng: null })).rejects.toThrow(/GPS/);
    await expect(submitAcceptedPlacement({ ...base(), lat: null, lng: -73.42 })).rejects.toThrow(/GPS/);
  });

  it('refuses out-of-range GPS when present', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    await expect(submitAcceptedPlacement({ ...base(), lat: 91, lng: 0 })).rejects.toThrow(/GPS/);
  });

  it('refuses a rate that is not a non-negative integer number of cents', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    await expect(submitAcceptedPlacement({ ...base(), lat: null, lng: null, rateCents: -1 })).rejects.toThrow(/rate/i);
    await expect(submitAcceptedPlacement({ ...base(), lat: null, lng: null, rateCents: 2.5 })).rejects.toThrow(/rate/i);
    await expect(submitAcceptedPlacement({ ...base(), lat: null, lng: null, rateCents: Number.NaN })).rejects.toThrow(/rate/i);
  });

  it('refuses a missing proof photo path', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    await expect(submitAcceptedPlacement({ ...base(), lat: null, lng: null, photoPath: '  ' })).rejects.toThrow(/photo/i);
  });

  it('a test worker flows is_test through, so bulk rows for test workers never touch real money', async () => {
    const { submitAcceptedPlacement } = await import('./placements');
    const p = await submitAcceptedPlacement({ ...base(), lat: null, lng: null, isTest: true });
    expect(p.isTest).toBe(true);
  });
});

describe('unacceptPlacement (the undo lever for a wrong accept, admin lens HIGH on PR #1093)', () => {
  it('moves an accepted row to rejected, CLEARS the stamped rate, records reason and reviewer', async () => {
    const { unacceptPlacement } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    const p = seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T16:00:00.000Z',
    });

    const undone = await unacceptPlacement(String(p.id), REVIEWER, 'uploaded to the wrong campaign');
    expect(undone.status).toBe('rejected');
    expect(undone.acceptedRateCents).toBeNull();
    expect(undone.rejectionReason).toBe('uploaded to the wrong campaign');
    expect(undone.reviewedBy).toBe(REVIEWER);
  });

  it('requires a reason', async () => {
    const { unacceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, status: 'accepted', accepted_rate_cents: 250, reviewed_by: REVIEWER, reviewed_at: 'x' });
    await expect(unacceptPlacement(String(p.id), REVIEWER, '   ')).rejects.toThrow(/reason/i);
  });

  it('a retried unaccept returns the already-rejected row unchanged (pays-zero stays pays-zero)', async () => {
    const { unacceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, status: 'accepted', accepted_rate_cents: 250, reviewed_by: REVIEWER, reviewed_at: 'x' });
    await unacceptPlacement(String(p.id), REVIEWER, 'mistake');
    const again = await unacceptPlacement(String(p.id), REVIEWER, 'mistake');
    expect(again.status).toBe('rejected');
    expect(again.acceptedRateCents).toBeNull();
  });

  it('refuses to touch a pending row: unaccept exists for accepted rows only', async () => {
    const { unacceptPlacement } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    const p = seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, status: 'pending' });
    await expect(unacceptPlacement(String(p.id), REVIEWER, 'mistake')).rejects.toThrow(/accepted/i);
  });
});

describe('findAcceptedByPhotoHash (bulk dedupe, technical lens HIGH on PR #1093)', () => {
  it('finds an accepted row with the same hash for the same worker and campaign', async () => {
    const { findAcceptedByPhotoHash } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: 'x',
      photo_hash: 'aaaa111122223333',
    });
    const hit = await findAcceptedByPhotoHash(String(worker.id), String(campaign.id), 'aaaa111122223333');
    expect(hit?.photoHash).toBe('aaaa111122223333');
  });

  it('a different worker, different campaign, non-accepted status, or null hash never matches', async () => {
    const { findAcceptedByPhotoHash } = await import('./placements');
    const campaign = seedCampaign();
    const worker = seedWorker();
    seedPlacement({ campaign_id: campaign.id, worker_id: worker.id, status: 'pending', photo_hash: 'aaaa111122223333' });
    expect(await findAcceptedByPhotoHash(String(worker.id), String(campaign.id), 'aaaa111122223333')).toBeNull();
    expect(await findAcceptedByPhotoHash('other-worker', String(campaign.id), 'aaaa111122223333')).toBeNull();
    expect(await findAcceptedByPhotoHash(String(worker.id), String(campaign.id), null)).toBeNull();
  });
});

describe('earnings bucket by the day the work HAPPENED (capturedAt first; Naldo date-taken ruling, PR #1093)', () => {
  it('a backfilled accepted photo lands in its historical week, not the upload week', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-29T18:00:00.000Z',
      captured_at: '2026-07-01T15:00:00.000Z',
    });
    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.byWeek).toEqual([{ weekStart: '2026-06-29', pendingEstimatedCents: 0, acceptedEarnedCents: 250 }]);
  });

  it('an accepted row with no capturedAt still buckets by review time (nothing vanishes)', async () => {
    const { earningsSummary } = await import('./placements');
    const campaign = seedCampaign({ rate_cents: 250 });
    const worker = seedWorker();
    seedPlacement({
      campaign_id: campaign.id,
      worker_id: worker.id,
      status: 'accepted',
      accepted_rate_cents: 250,
      reviewed_by: REVIEWER,
      reviewed_at: '2026-08-24T12:00:00.000Z',
      captured_at: null,
    });
    const summaries = await earningsSummary();
    const mine = summaries.find((s) => s.workerId === worker.id);
    expect(mine?.byWeek).toEqual([{ weekStart: '2026-08-24', pendingEstimatedCents: 0, acceptedEarnedCents: 250 }]);
    expect(mine?.total.acceptedEarnedCents).toBe(250);
  });
});
