import { beforeEach, describe, expect, it, vi } from 'vitest';

// Campaign rate config is MONEY: rate_cents is the per-accepted-yard-sign
// rate that gets stamped onto placements at acceptance. These tests pin the
// $2.50 default and the integer-cents guard.

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rows: [] as AnyRow[],
      inserted: [] as AnyRow[],
      activity: [] as AnyRow[],
      // How many photos point at a campaign, keyed by campaign id. The
      // delete guard reads this.
      placementCounts: new Map<string, number>(),
      // When true, the audit insert fails the way a refused write really
      // does: supabase-js returns { error } rather than throwing.
      activityInsertFails: false,
      // When set, the NEXT single-row select returns this snapshot instead
      // of the live row, then clears — models a stale read racing a
      // concurrent writer.
      staleReadOnce: null as AnyRow | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function makeDb() {
  return {
    from(table: string) {
      if (table === 'advertising_activity') {
        return {
          insert(payload: AnyRow) {
            if (stateRef.current.activityInsertFails) {
              return Promise.resolve({ data: null, error: { message: 'row-level security refused this insert' } });
            }
            stateRef.current.activity.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === 'advertising_placements') {
        return {
          select(_cols?: string, _opts?: { count?: string; head?: boolean }) {
            const b = {
              eq(_col: string, val: unknown) {
                const count = stateRef.current.placementCounts.get(String(val)) ?? 0;
                return Promise.resolve({ data: null, error: null, count });
              },
            };
            return b;
          },
        };
      }
      return {
        select(_cols?: string) {
          const filters: Array<(r: AnyRow) => boolean> = [];
          const b = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return b;
            },
            maybeSingle() {
              if (stateRef.current.staleReadOnce) {
                const stale = stateRef.current.staleReadOnce;
                stateRef.current.staleReadOnce = null;
                return Promise.resolve({ data: stale, error: null });
              }
              const found = stateRef.current.rows.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: found[0] ?? null, error: null });
            },
            order(_col: string, _opts?: unknown) {
              return Promise.resolve({
                data: stateRef.current.rows.filter((r) => filters.every((f) => f(r))),
                error: null,
              });
            },
          };
          return b;
        },
        insert(payload: AnyRow) {
          const row = {
            id: `campaign-${stateRef.current.rows.length + 1}`,
            notes: null,
            active: true,
            is_test: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...payload,
          };
          stateRef.current.rows.push(row);
          stateRef.current.inserted.push(payload);
          return {
            select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          };
        },
        delete() {
          const filters: Array<(r: AnyRow) => boolean> = [];
          const db = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return db;
            },
            then(onOk: (v: { error: null }) => unknown) {
              stateRef.current.rows = stateRef.current.rows.filter((r) => !filters.every((f) => f(r)));
              return Promise.resolve({ error: null }).then(onOk);
            },
          };
          return db;
        },
        update(payload: AnyRow) {
          const filters: Array<(r: AnyRow) => boolean> = [];
          const ub = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return ub;
            },
            select(_cols?: string) {
              return {
                maybeSingle: () => {
                  const idx = stateRef.current.rows.findIndex((r) => filters.every((f) => f(r)));
                  if (idx === -1) return Promise.resolve({ data: null, error: null });
                  stateRef.current.rows[idx] = { ...stateRef.current.rows[idx], ...payload };
                  return Promise.resolve({ data: stateRef.current.rows[idx], error: null });
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

beforeEach(() => {
  stateRef.current.rows = [];
  stateRef.current.inserted = [];
  stateRef.current.activity = [];
  stateRef.current.staleReadOnce = null;
  stateRef.current.placementCounts = new Map();
  stateRef.current.activityInsertFails = false;
  dbRef.current = makeDb();
});

describe('createAdvertisingCampaign', () => {
  it('defaults the rate to 250 cents ($2.50 per accepted yard sign, Naldo 2026-08-27)', async () => {
    const { createAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    expect(campaign.rateCents).toBe(250);
    expect(stateRef.current.inserted[0].rate_cents).toBe(250);
  });

  it('refuses a negative or fractional-cent rate', async () => {
    const { createAdvertisingCampaign } = await import('./campaigns');
    await expect(createAdvertisingCampaign({ name: 'Bad', rateCents: -1 })).rejects.toThrow(/rate/i);
    await expect(createAdvertisingCampaign({ name: 'Bad', rateCents: 250.5 })).rejects.toThrow(/rate/i);
  });
});

describe('updateAdvertisingCampaign', () => {
  it('patches the rate in integer cents and refuses bad rates', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });

    const updated = await updateAdvertisingCampaign(campaign.id, { rateCents: 300 }, 'admin-user-1');
    expect(updated?.rateCents).toBe(300);

    await expect(
      updateAdvertisingCampaign(campaign.id, { rateCents: 1.5 }, 'admin-user-1'),
    ).rejects.toThrow(/rate/i);
  });

  it('a rate change that loses a concurrent-edit race throws and logs nothing', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign, CampaignRateConflictError } =
      await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    // Another admin's edit (250 -> 260) lands between this caller's
    // prior-rate read and their write: the stored row is at 260, but this
    // caller's read still sees 250.
    stateRef.current.rows[0].rate_cents = 260;
    stateRef.current.staleReadOnce = { ...stateRef.current.rows[0], rate_cents: 250 };
    stateRef.current.activity = [];

    await expect(
      updateAdvertisingCampaign(campaign.id, { rateCents: 300 }, 'admin-user-1'),
    ).rejects.toThrow(CampaignRateConflictError);

    expect(stateRef.current.rows[0].rate_cents).toBe(260); // the other admin's rate survives
    expect(stateRef.current.activity.filter((a) => a.action === 'rate_changed')).toHaveLength(0);
  });

  it('a rate change writes a rate_changed audit row carrying prior and new rate', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { rateCents: 300 }, 'admin-user-1');

    const audit = stateRef.current.activity.filter((a) => a.action === 'rate_changed');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('admin-user-1');
    const detail = audit[0].detail as { priorRateCents: number; newRateCents: number };
    expect(detail.priorRateCents).toBe(250);
    expect(detail.newRateCents).toBe(300);
  });

  it('a patch that does not touch the rate writes no rate_changed row', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { notes: 'east side routes' }, 'admin-user-1');
    // Same-value rate patch is also not a change.
    await updateAdvertisingCampaign(campaign.id, { rateCents: 250 }, 'admin-user-1');

    expect(stateRef.current.activity.filter((a) => a.action === 'rate_changed')).toHaveLength(0);
  });
});

// Renaming a campaign is a real edit to shared config: the name is what the
// office, the crew and every audit detail read. Every other write in this
// module leaves a trail; a rename left none until now (admin lens, PR #1153).
describe('updateAdvertisingCampaign — the name and description trail', () => {
  it('a rename writes a campaign_edited row carrying the prior and new name', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { name: 'Fall yard signs' }, 'admin-user-1');

    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_edited');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('admin-user-1');
    const detail = audit[0].detail as { priorName?: string; newName?: string };
    expect(detail.priorName).toBe('Fall signs');
    expect(detail.newName).toBe('Fall yard signs');
  });

  it('a description change is recorded too', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { notes: 'east side routes' }, 'admin-user-1');

    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_edited');
    expect(audit).toHaveLength(1);
    const detail = audit[0].detail as { priorNotes?: string | null; newNotes?: string | null };
    expect(detail.priorNotes).toBe(null);
    expect(detail.newNotes).toBe('east side routes');
  });

  it('re-saving the same name and description writes nothing', async () => {
    // Opening the sheet and pressing Save without typing is a normal thing
    // to do, and it is not an edit.
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { name: 'Fall signs', notes: null }, 'admin-user-1');

    expect(stateRef.current.activity.filter((a) => a.action === 'campaign_edited')).toHaveLength(0);
  });

  it('a rate-only change writes rate_changed and no campaign_edited', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { rateCents: 300 }, 'admin-user-1');

    expect(stateRef.current.activity.filter((a) => a.action === 'rate_changed')).toHaveLength(1);
    expect(stateRef.current.activity.filter((a) => a.action === 'campaign_edited')).toHaveLength(0);
  });
});

describe('updateAdvertisingCampaign — an edit row only claims the fields it was asked to change', () => {
  it('a name-only patch never reports a description change made by someone else', async () => {
    // The audit row is written by comparing the row this caller READ against
    // the row that came back from the write. Another admin's description
    // edit landing in that gap is not this caller's edit, and claiming it is
    // puts one person's words under another person's name. Reported by the
    // adversarial delta-verify on this PR's own fix round.
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.rows[0].notes = 'east side routes';
    stateRef.current.staleReadOnce = { ...stateRef.current.rows[0], notes: null };
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { name: 'Fall yard signs' }, 'admin-user-1');

    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_edited');
    expect(audit).toHaveLength(1);
    const detail = audit[0].detail as Record<string, unknown>;
    expect(detail.newName).toBe('Fall yard signs');
    expect('priorNotes' in detail).toBe(false);
    expect('newNotes' in detail).toBe(false);
  });

  it('a description-only patch never reports a rename made by someone else', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.rows[0].name = 'Renamed by someone else';
    stateRef.current.staleReadOnce = { ...stateRef.current.rows[0], name: 'Fall signs' };
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { notes: 'east side routes' }, 'admin-user-1');

    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_edited');
    expect(audit).toHaveLength(1);
    const detail = audit[0].detail as Record<string, unknown>;
    expect(detail.newNotes).toBe('east side routes');
    expect('priorName' in detail).toBe(false);
    expect('newName' in detail).toBe(false);
  });
});

// Deleting a campaign, and the two things that make it safe: it is refused
// while any photo points at it, and the record of the deletion is written
// BEFORE the row goes, never after (the void-then-record ordering that cost
// a payroll row in an earlier session).
describe('deleteAdvertisingCampaign', () => {
  it('refuses while any photo points at the campaign, and deletes nothing', async () => {
    const { createAdvertisingCampaign, deleteAdvertisingCampaign, CampaignHasPhotosError } =
      await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall signs' });
    stateRef.current.placementCounts.set(campaign.id, 3);

    await expect(deleteAdvertisingCampaign(campaign.id, 'admin-user-1')).rejects.toThrow(
      CampaignHasPhotosError,
    );
    expect(stateRef.current.rows).toHaveLength(1);
  });

  it('deletes a campaign with no photos and records who did it', async () => {
    const { createAdvertisingCampaign, deleteAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Typo', rateCents: 300 });
    stateRef.current.activity = [];

    await deleteAdvertisingCampaign(campaign.id, 'admin-user-1');

    expect(stateRef.current.rows).toHaveLength(0);
    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_deleted');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('admin-user-1');
    const detail = audit[0].detail as { name: string; rateCents: number };
    expect(detail.name).toBe('Typo');
    expect(detail.rateCents).toBe(300);
  });

  it('refuses to delete when the record of the deletion cannot be written', async () => {
    // The audit row is the only thing that will survive the campaign. If it
    // cannot be written the campaign stays, because a row that still exists
    // is the recoverable half of that pair.
    const { createAdvertisingCampaign, deleteAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Typo' });
    stateRef.current.activityInsertFails = true;

    await expect(deleteAdvertisingCampaign(campaign.id, 'admin-user-1')).rejects.toThrow();
    expect(stateRef.current.rows).toHaveLength(1);
  });

  it('refuses a campaign that does not exist rather than reporting success', async () => {
    const { deleteAdvertisingCampaign } = await import('./campaigns');
    await expect(deleteAdvertisingCampaign('nope', 'admin-user-1')).rejects.toThrow(/no campaign/i);
  });
});

describe('updateAdvertisingCampaign — the campaign type', () => {
  it('changes the type and records the move', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall', kind: 'yard_sign' });
    stateRef.current.activity = [];

    const updated = await updateAdvertisingCampaign(campaign.id, { kind: 'door_hanger' }, 'admin-user-1');

    expect(updated?.kind).toBe('door_hanger');
    const audit = stateRef.current.activity.filter((a) => a.action === 'campaign_edited');
    expect(audit).toHaveLength(1);
    const detail = audit[0].detail as { priorKind?: string; newKind?: string };
    expect(detail.priorKind).toBe('yard_sign');
    expect(detail.newKind).toBe('door_hanger');
  });

  it('re-saving the same type records nothing', async () => {
    const { createAdvertisingCampaign, updateAdvertisingCampaign } = await import('./campaigns');
    const campaign = await createAdvertisingCampaign({ name: 'Fall', kind: 'yard_sign' });
    stateRef.current.activity = [];

    await updateAdvertisingCampaign(campaign.id, { kind: 'yard_sign' }, 'admin-user-1');

    expect(stateRef.current.activity.filter((a) => a.action === 'campaign_edited')).toHaveLength(0);
  });
});
