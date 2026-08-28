// Row 423 — the design-change trail on a booked order.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef, getOperatorMock, appendMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getOperatorMock: vi.fn(async () => ({ id: 'op-1', email: 'jason@yulelovelights.com' })),
  appendMock: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));
vi.mock('@/lib/auth/supabaseServer', () => ({ getOperator: getOperatorMock }));
vi.mock('@/lib/quoteAudit', () => ({ appendQuoteAuditEntry: appendMock }));

import { recordDesignChange, alreadyRecorded, businessDay } from './designAudit';

const DESIGN = 'd-1';
const QUOTE = 'q-1';

function sbWith(snapshot: unknown, error?: string) {
  return {
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () =>
          error ? { data: null, error: { message: error } } : { data: { approval_snapshot: snapshot }, error: null },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'jason@yulelovelights.com' });
  appendMock.mockResolvedValue(true);
});

describe('businessDay', () => {
  it('uses the ET business day, not the UTC one', () => {
    // 2026-08-28T02:30:00Z is still the EVENING of the 27th in ET. Taking the
    // UTC day would roll the trail over mid-session and write a second entry
    // for the same evening — the same trap ledger row 335 records for the
    // schedule page.
    expect(businessDay(new Date('2026-08-28T02:30:00Z'))).toBe('2026-08-27');
    expect(businessDay(new Date('2026-08-27T16:00:00Z'))).toBe('2026-08-27');
  });
});

describe('alreadyRecorded', () => {
  const day = '2026-08-27';
  const snap = { designChanges: [{ by: 'a@x.com', at: 'x', designId: DESIGN, day }] };

  it('matches on designId + operator + day together, never on one alone', () => {
    expect(alreadyRecorded(snap, DESIGN, 'a@x.com', day)).toBe(true);
    expect(alreadyRecorded(snap, DESIGN, 'b@x.com', day)).toBe(false); // other operator
    expect(alreadyRecorded(snap, 'other', 'a@x.com', day)).toBe(false); // other design
    expect(alreadyRecorded(snap, DESIGN, 'a@x.com', '2026-08-28')).toBe(false); // next day
  });

  it('is false for a snapshot with no trail, and for junk', () => {
    expect(alreadyRecorded(null, DESIGN, 'a@x.com', day)).toBe(false);
    expect(alreadyRecorded({}, DESIGN, 'a@x.com', day)).toBe(false);
    expect(alreadyRecorded({ designChanges: 'nope' }, DESIGN, 'a@x.com', day)).toBe(false);
  });
});

describe('recordDesignChange', () => {
  it('appends once, with who / when / which design', async () => {
    sbRef.current = sbWith({ currentTotalUsd: 5000 });
    await recordDesignChange(DESIGN, QUOTE, new Date('2026-08-27T16:00:00Z'));

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, quoteId, key, entry] = appendMock.mock.calls[0] as unknown[];
    expect(quoteId).toBe(QUOTE);
    expect(key).toBe('designChanges');
    expect(entry).toMatchObject({
      by: 'jason@yulelovelights.com',
      designId: DESIGN,
      day: '2026-08-27',
    });
  });

  it('is a NO-OP on the same operator, design and day — the whole point', async () => {
    // The editor autosaves on a 600ms debounce. Without this, one afternoon of
    // editing writes hundreds of entries and buries the signal.
    sbRef.current = sbWith({
      designChanges: [{ by: 'jason@yulelovelights.com', at: 'x', designId: DESIGN, day: '2026-08-27' }],
    });
    await recordDesignChange(DESIGN, QUOTE, new Date('2026-08-27T19:00:00Z'));
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('writes again the NEXT day, and for a DIFFERENT operator the same day', async () => {
    const existing = { designChanges: [{ by: 'jason@yulelovelights.com', at: 'x', designId: DESIGN, day: '2026-08-27' }] };

    sbRef.current = sbWith(existing);
    await recordDesignChange(DESIGN, QUOTE, new Date('2026-08-28T16:00:00Z'));
    expect(appendMock).toHaveBeenCalledTimes(1);

    appendMock.mockClear();
    getOperatorMock.mockResolvedValue({ id: 'op-2', email: 'naldo@yulelovelights.com' });
    sbRef.current = sbWith(existing);
    await recordDesignChange(DESIGN, QUOTE, new Date('2026-08-27T20:00:00Z'));
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, and appends nothing, when the snapshot read fails', async () => {
    sbRef.current = sbWith(null, 'boom');
    await expect(recordDesignChange(DESIGN, QUOTE)).resolves.toBeUndefined();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('never throws when there is no service client at all', async () => {
    sbRef.current = null;
    await expect(recordDesignChange(DESIGN, QUOTE)).resolves.toBeUndefined();
    expect(appendMock).not.toHaveBeenCalled();
  });
});
