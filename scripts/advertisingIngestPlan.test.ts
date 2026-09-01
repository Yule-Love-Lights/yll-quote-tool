// The money behind a bulk ingest. Every accepted photo pays a real person,
// and the dollar total is read back to Naldo before the run, so these are
// the failure modes that would make that number a lie: a duplicate counted
// as pay, an unusable file counted as pay, a fractional rate, and a name
// that matches two people.

import { describe, expect, it } from 'vitest';

import {
  checkApproval,
  dollars,
  planIngest,
  resolveAdmin,
  resolveByNameOrId,
  type IngestCandidate,
} from './advertisingIngestPlan';

function candidate(over: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    file: 'IMG_0001.jpg',
    bytes: 1_200_000,
    lat: 40.7,
    lng: -73.4,
    takenAt: '2026-08-01T14:00:00.000Z',
    photoHash: 'abc',
    duplicateOfPlacementId: null,
    duplicateOfFile: null,
    problem: null,
    ...over,
  };
}

describe('planIngest — what the run will actually pay', () => {
  it('pays only for the photos it will really create', () => {
    const plan = planIngest(
      [
        candidate({ file: 'a.jpg' }),
        candidate({ file: 'b.jpg' }),
        candidate({ file: 'c.jpg', duplicateOfPlacementId: 'placement-9' }),
        candidate({ file: 'd.png', problem: 'not a JPEG, PNG or WebP photo' }),
      ],
      250,
    );
    expect(plan.send.map((c) => c.file)).toEqual(['a.jpg', 'b.jpg']);
    expect(plan.duplicates.map((c) => c.file)).toEqual(['c.jpg']);
    expect(plan.problems.map((c) => c.file)).toEqual(['d.png']);
    expect(plan.payCents).toBe(500);
    expect(plan.totalFiles).toBe(4);
  });

  it('a duplicate pays nothing, however many there are', () => {
    const plan = planIngest(
      Array.from({ length: 20 }, (_, i) => candidate({ file: `x${i}.jpg`, duplicateOfPlacementId: 'p1' })),
      250,
    );
    expect(plan.payCents).toBe(0);
    expect(plan.send).toHaveLength(0);
  });

  it('an unusable file is reported as a problem, never as a duplicate', () => {
    // Both flags set at once: saying "already uploaded" about a file we
    // cannot read would tell the admin we hold a paid copy that does not
    // exist.
    const plan = planIngest(
      [candidate({ problem: 'too large even after downscaling', duplicateOfPlacementId: 'p1' })],
      250,
    );
    expect(plan.problems).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(0);
    expect(plan.payCents).toBe(0);
  });

  it('the total is whole cents, never a float', () => {
    const plan = planIngest([candidate(), candidate({ file: 'b.jpg' }), candidate({ file: 'c.jpg' })], 333);
    expect(plan.payCents).toBe(999);
    expect(Number.isInteger(plan.payCents)).toBe(true);
    expect(dollars(plan.payCents)).toBe('$9.99');
  });

  it('refuses a rate that is not whole cents rather than quietly rounding it', () => {
    expect(() => planIngest([candidate()], 2.5)).toThrow(/whole number of cents/);
    expect(() => planIngest([candidate()], -1)).toThrow(/whole number of cents/);
  });

  it('an empty folder pays nothing', () => {
    expect(planIngest([], 250).payCents).toBe(0);
  });
});

describe('resolveByNameOrId — paying the right person', () => {
  const rows = [
    { id: 'w-1', name: 'Tiago' },
    { id: 'w-2', name: 'tiago' },
    { id: 'w-3', name: 'Marco' },
  ];

  it('an id wins outright, even when names collide', () => {
    const r = resolveByNameOrId(rows, 'w-2', 'crew member');
    expect(r.ok && r.row.id).toBe('w-2');
  });

  it('refuses a name that matches two people instead of guessing', () => {
    const r = resolveByNameOrId(rows, 'Tiago', 'crew member');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/More than one/);
  });

  it('matches one name regardless of case and surrounding space', () => {
    const r = resolveByNameOrId([{ id: 'c-1', name: 'Fall yard signs' }], '  fall YARD signs ', 'campaign');
    expect(r.ok && r.row.id).toBe('c-1');
  });

  it('refuses an unknown name and says what it knows', () => {
    const r = resolveByNameOrId(rows, 'Nobody', 'crew member');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/Marco/);
  });

  it('refuses an empty query', () => {
    expect(resolveByNameOrId(rows, '   ', 'campaign').ok).toBe(false);
  });
});

// Found by running the thing: the first live rehearsal created one row and
// reported the second photo as already uploaded, because the two were
// duplicates of EACH OTHER. The dry run had promised to pay for both. The
// total read back to Naldo before a run has to account for duplicates inside
// the folder, not only for photos already stored.
describe('planIngest - a duplicate inside the same folder', () => {
  it('pays once when the same photo appears twice in the batch', () => {
    const plan = planIngest(
      [
        candidate({ file: 'a.jpg', photoHash: 'same' }),
        candidate({ file: 'a-copy.jpg', photoHash: 'same', duplicateOfFile: 'a.jpg' }),
      ],
      250,
    );
    expect(plan.send.map((c) => c.file)).toEqual(['a.jpg']);
    expect(plan.duplicates.map((c) => c.file)).toEqual(['a-copy.jpg']);
    expect(plan.payCents).toBe(250);
  });

  it('an unusable file still outranks a within-folder duplicate', () => {
    const plan = planIngest(
      [candidate({ problem: 'could not be read as an image', duplicateOfFile: 'a.jpg' })],
      250,
    );
    expect(plan.problems).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(0);
  });
});

// A live run pays exactly the figure that was read back and approved, or it
// pays nothing. Without this the two numbers are connected only by hope: the
// campaign rate can move between the dry run and the live one, and a folder
// that syncs from Drive can gain a photo in the same window.
describe('checkApproval', () => {
  it('lets a dry run through with no approved figure', () => {
    expect(checkApproval(11750, null, false).ok).toBe(true);
  });

  it('refuses a live run that was never given an approved figure', () => {
    const r = checkApproval(11750, null, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/without --live first/);
  });

  it('lets a live run through when the figures match to the cent', () => {
    expect(checkApproval(11750, 11750, true).ok).toBe(true);
  });

  it('refuses a live run that would pay more than was approved', () => {
    const r = checkApproval(12000, 11750, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/\$120\.00/);
    expect(!r.ok && r.reason).toMatch(/\$117\.50/);
  });

  it('refuses a live run that would pay LESS than was approved', () => {
    // Paying less is not automatically safe: it means photos vanished from
    // the plan, and the person approving should see why before it runs.
    expect(checkApproval(10000, 11750, true).ok).toBe(false);
  });

  it('refuses an approved figure that is not whole cents', () => {
    expect(checkApproval(11750, 11750.5, true).ok).toBe(false);
    expect(checkApproval(11750, -1, true).ok).toBe(false);
  });
});

// Every photo records WHO accepted it, as a real foreign key to an auth
// user. Guessing puts a wrong fact in the audit trail, and this business has
// more than one admin account (admin lens on this PR).
describe('resolveAdmin', () => {
  const users = [
    { id: 'u-1', email: 'naldo@yulelovelights.com', app_metadata: { role: 'admin' } },
    { id: 'u-2', email: 'jason@yulelovelights.com', app_metadata: { role: 'admin' } },
    { id: 'u-3', email: 'crew@yulelovelights.com', app_metadata: { role: 'operator' } },
  ];

  it('refuses to guess when more than one admin exists, and names them', () => {
    expect(() => resolveAdmin(users, undefined)).toThrow(/2 admin accounts/);
    expect(() => resolveAdmin(users, undefined)).toThrow(/naldo@yulelovelights.com/);
  });

  it('takes the one admin when there is only one', () => {
    expect(resolveAdmin([users[0], users[2]], undefined)).toBe('u-1');
  });

  it('matches by email, ignoring case', () => {
    expect(resolveAdmin(users, 'JASON@yulelovelights.com')).toBe('u-2');
  });

  it('matches by id', () => {
    expect(resolveAdmin(users, 'u-1')).toBe('u-1');
  });

  it('refuses a non-admin account even when named exactly', () => {
    expect(() => resolveAdmin(users, 'crew@yulelovelights.com')).toThrow(/No admin account matches/);
  });

  it('refuses when there are no admins at all', () => {
    expect(() => resolveAdmin([users[2]], undefined)).toThrow(/No admin account found/);
  });
});
