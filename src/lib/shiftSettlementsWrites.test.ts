// The WRITE paths of shiftSettlements.ts, against a mocked database.
//
// Split from shiftSettlements.test.ts, which covers the pure money maths, so
// the module-level vi.mock here cannot affect those. The technical lens on
// PR #1179 flagged that record and undo shipped with no tests at all, unlike
// the advertising settlement module this one mirrors — whose own test file
// carries a note warning against exactly that gap.
//
// What is worth pinning here is not the happy path, it is the refusals and
// the unwinds: this is the code that decides whether somebody gets paid
// twice, and whether a failed write leaves money on the books that covers
// nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DbError = { code?: string; message: string };

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
};

type LineRow = {
  id: string;
  settlement_id: string;
  shift_id: string;
  paid_seconds: number;
  rate_cents_per_hour: number;
  reference_cents: number;
  voided_at: string | null;
};

type SettlementRow = {
  id: string;
  crew_member_id: string;
  total_cents: number;
  method: string;
  note: string | null;
  paid_at: string;
  paid_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

const { dbRef, stateRef, sendTelegramMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  sendTelegramMock: vi.fn(async (_chatId: string, _text: string) => undefined),
  stateRef: {
    current: {
      crew: [] as { id: string; display_name: string; base_rate_cents: number; telegram_user_id: string | null }[],
      shifts: [] as ShiftRow[],
      breaks: [] as { shift_id: string; started_at: string; ended_at: string | null }[],
      settlements: [] as SettlementRow[],
      lines: [] as LineRow[],
      breakReadError: null as DbError | null,
      lineInsertError: null as DbError | null,
      settlementDeleteError: null as DbError | null,
      lineUpdateError: null as DbError | null,
      settlementUpdateError: null as DbError | null,
      /** Rows the LINE insert actually returns, to model a short insert. */
      lineInsertReturnsFewer: false,
      deletedSettlementIds: [] as string[],
    },
  },
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));
vi.mock('@/lib/integrations/telegram', () => ({ sendTelegramMessage: sendTelegramMock }));

function makeDb() {
  return {
    from(table: string) {
      if (table === 'crew_members') {
        let list = [...stateRef.current.crew];
        const b = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return b;
          },
          maybeSingle: () => Promise.resolve({ data: list[0] ? { ...list[0] } : null, error: null }),
        };
        return b as never;
      }

      if (table === 'shifts') {
        let list = [...stateRef.current.shifts];
        const b = {
          select: () => b,
          in: (col: string, vals: unknown[]) => {
            list = list.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
            return Promise.resolve({ data: list.map((r) => ({ ...r })), error: null });
          },
        };
        return b as never;
      }

      if (table === 'shift_breaks') {
        let list = [...stateRef.current.breaks];
        const b = {
          select: () => b,
          in: (col: string, vals: unknown[]) => {
            if (stateRef.current.breakReadError) {
              return Promise.resolve({ data: null, error: stateRef.current.breakReadError });
            }
            list = list.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
            return Promise.resolve({ data: list.map((r) => ({ ...r })), error: null });
          },
        };
        return b as never;
      }

      if (table === 'shift_settlement_lines') {
        return {
          select: () => {
            let list = [...stateRef.current.lines];
            const rb = {
              in: (col: string, vals: unknown[]) => {
                list = list.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
                return rb;
              },
              eq: (col: string, val: unknown) => {
                list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
                return rb;
              },
              is: (col: string, val: unknown) => {
                if (val === null) {
                  list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === null);
                }
                return rb;
              },
              order: () => rb,
              range: () => Promise.resolve({ data: list.map((r) => ({ ...r })), error: null }),
            };
            return rb;
          },
          insert: (payload: Record<string, unknown>[]) => ({
            select: () => {
              if (stateRef.current.lineInsertError) {
                return Promise.resolve({ data: null, error: stateRef.current.lineInsertError });
              }
              // The real guarantee is the partial unique index; model it.
              for (const row of payload) {
                const clash = stateRef.current.lines.some(
                  (l) => l.shift_id === row.shift_id && l.voided_at === null,
                );
                if (clash) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message: 'duplicate key value violates unique constraint "shift_settlement_lines_shift_key"',
                    },
                  });
                }
              }
              const created = payload.map((row, i) => ({
                id: `line-${stateRef.current.lines.length + i + 1}`,
                settlement_id: String(row.settlement_id),
                shift_id: String(row.shift_id),
                paid_seconds: Number(row.paid_seconds),
                rate_cents_per_hour: Number(row.rate_cents_per_hour),
                reference_cents: Number(row.reference_cents),
                voided_at: null,
              }));
              stateRef.current.lines.push(...created);
              const returned = stateRef.current.lineInsertReturnsFewer ? created.slice(0, -1) : created;
              return Promise.resolve({ data: returned, error: null });
            },
          }),
          update: (payload: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const ub = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return ub;
              },
              is: (col: string, val: unknown) => {
                filters[col] = val;
                return ub;
              },
              then: (res: (v: { error: DbError | null }) => unknown, rej?: (e: unknown) => unknown) => {
                if (stateRef.current.lineUpdateError) {
                  return Promise.resolve({ error: stateRef.current.lineUpdateError }).then(res, rej);
                }
                for (const line of stateRef.current.lines) {
                  const rec = line as unknown as Record<string, unknown>;
                  if (Object.entries(filters).every(([k, v]) => rec[k] === v)) {
                    Object.assign(line, payload);
                  }
                }
                return Promise.resolve({ error: null }).then(res, rej);
              },
            };
            return ub;
          },
        } as never;
      }

      if (table === 'shift_settlements') {
        return {
          select: () => {
            let list = [...stateRef.current.settlements];
            const rb = {
              eq: (col: string, val: unknown) => {
                list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
                return rb;
              },
              order: () => rb,
              range: () => Promise.resolve({ data: list.map((r) => ({ ...r })), error: null }),
              maybeSingle: () =>
                Promise.resolve({ data: list[0] ? { ...list[0] } : null, error: null }),
            };
            return rb;
          },
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              maybeSingle: () => {
                const row: SettlementRow = {
                  id: `settlement-${stateRef.current.settlements.length + 1}`,
                  crew_member_id: String(payload.crew_member_id),
                  total_cents: Number(payload.total_cents),
                  method: String(payload.method),
                  note: (payload.note as string | null) ?? null,
                  paid_at: String(payload.paid_at),
                  paid_by: (payload.paid_by as string | null) ?? null,
                  created_at: String(payload.paid_at),
                  voided_at: null,
                  voided_by: null,
                  void_reason: null,
                };
                stateRef.current.settlements.push(row);
                return Promise.resolve({ data: { ...row }, error: null });
              },
            }),
          }),
          delete: () => ({
            eq: (_col: string, val: unknown) => {
              if (stateRef.current.settlementDeleteError) {
                return Promise.resolve({ error: stateRef.current.settlementDeleteError });
              }
              stateRef.current.deletedSettlementIds.push(String(val));
              stateRef.current.settlements = stateRef.current.settlements.filter((s) => s.id !== val);
              return Promise.resolve({ error: null });
            },
          }),
          update: (payload: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const ub = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return ub;
              },
              is: (col: string, val: unknown) => {
                filters[col] = val;
                return ub;
              },
              select: () => ({
                maybeSingle: () => {
                  if (stateRef.current.settlementUpdateError) {
                    return Promise.resolve({ data: null, error: stateRef.current.settlementUpdateError });
                  }
                  const row = stateRef.current.settlements.find((s) => {
                    const rec = s as unknown as Record<string, unknown>;
                    return Object.entries(filters).every(([k, v]) => rec[k] === v);
                  });
                  if (!row) return Promise.resolve({ data: null, error: null });
                  Object.assign(row, payload);
                  return Promise.resolve({ data: { ...row }, error: null });
                },
              }),
            };
            return ub;
          },
        } as never;
      }

      throw new Error(`shiftSettlementsWrites.test.ts: unexpected table ${table}`);
    },
  };
}

const CLOSED: ShiftRow = {
  id: 'shift-1',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-09-01T12:00:00.000Z',
  clock_out_at: '2026-09-01T16:00:00.000Z',
};

const CLOSED_2: ShiftRow = {
  id: 'shift-2',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-08-31T12:00:00.000Z',
  clock_out_at: '2026-08-31T15:00:00.000Z',
};

const OPEN: ShiftRow = {
  id: 'shift-open',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-09-02T12:00:00.000Z',
  clock_out_at: null,
};

const OTHERS: ShiftRow = {
  id: 'shift-theirs',
  crew_member_id: 'crew-2',
  clock_in_at: '2026-09-01T12:00:00.000Z',
  clock_out_at: '2026-09-01T14:00:00.000Z',
};

beforeEach(() => {
  sendTelegramMock.mockClear();
  stateRef.current = {
    crew: [
      { id: 'crew-1', display_name: 'Khaye', base_rate_cents: 900, telegram_user_id: '555' },
      { id: 'crew-2', display_name: 'Naldo', base_rate_cents: 2500, telegram_user_id: null },
    ],
    shifts: [CLOSED, CLOSED_2, OPEN, OTHERS],
    breaks: [],
    settlements: [],
    lines: [],
    breakReadError: null,
    lineInsertError: null,
    settlementDeleteError: null,
    lineUpdateError: null,
    settlementUpdateError: null,
    lineInsertReturnsFewer: false,
    deletedSettlementIds: [],
  };
  dbRef.current = makeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const base = {
  crewMemberId: 'crew-1',
  shiftIds: ['shift-1'],
  totalCents: 4000,
  paidBy: 'Jason (jason@x)',
  method: 'cash' as const,
};

describe('recordShiftSettlement', () => {
  it('records the TYPED amount, and stamps the hours and rate as a reference beside it', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    // 4 hours at $9.00/hr is $36.00, but $40.00 was actually handed over.
    const out = await recordShiftSettlement({ ...base, totalCents: 4000 });
    expect(out.totalCents).toBe(4000);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.paidSeconds).toBe(4 * 3600);
    expect(out.lines[0]!.rateCentsPerHour).toBe(900);
    expect(out.lines[0]!.referenceCents).toBe(3600);
    // The gap is the whole point and must never be asserted away.
    expect(out.referenceCents).not.toBe(out.totalCents);
  });

  it('subtracts breaks from the stamped hours', async () => {
    stateRef.current.breaks = [
      { shift_id: 'shift-1', started_at: '2026-09-01T13:00:00.000Z', ended_at: '2026-09-01T13:30:00.000Z' },
    ];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement(base);
    expect(out.lines[0]!.paidSeconds).toBe(3.5 * 3600);
  });

  it('REFUSES a shift that is still running, because its hours are still growing', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(
      recordShiftSettlement({ ...base, shiftIds: ['shift-open'] }),
    ).rejects.toMatchObject({ code: 'still-open' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it("REFUSES somebody else's shift", async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(
      recordShiftSettlement({ ...base, shiftIds: ['shift-theirs'] }),
    ).rejects.toMatchObject({ code: 'not-theirs' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('REFUSES a shift that is already on a live settlement line', async () => {
    stateRef.current.lines = [
      { id: 'l0', settlement_id: 'old', shift_id: 'shift-1', paid_seconds: 1, rate_cents_per_hour: 900, reference_cents: 0, voided_at: null },
    ];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'already-settled' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('ALLOWS a shift whose previous payment was voided', async () => {
    stateRef.current.lines = [
      { id: 'l0', settlement_id: 'old', shift_id: 'shift-1', paid_seconds: 1, rate_cents_per_hour: 900, reference_cents: 0, voided_at: '2026-09-02T09:00:00.000Z' },
    ];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement(base);
    expect(out.totalCents).toBe(4000);
  });

  it('REFUSES a zero or negative amount, so a payment always records money', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    for (const totalCents of [0, -1, 1.5]) {
      await expect(recordShiftSettlement({ ...base, totalCents })).rejects.toMatchObject({
        code: 'invalid-amount',
      });
    }
  });

  it('REFUSES an empty selection', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement({ ...base, shiftIds: [] })).rejects.toMatchObject({
      code: 'no-shifts',
    });
  });

  it('REFUSES when the breaks cannot be read, rather than overstating the hours it covered', async () => {
    stateRef.current.breakReadError = { message: 'connection reset' };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toThrow(/breaks could not be read/);
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('UNWINDS the payment when the shifts cannot be attached, so no empty payment is left on the books', async () => {
    stateRef.current.lineInsertError = { message: 'nope' };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toThrow(/nothing was recorded/);
    expect(stateRef.current.settlements).toHaveLength(0);
    expect(stateRef.current.deletedSettlementIds).toHaveLength(1);
  });

  it('loses a double-submit to the database, and unwinds its own settlement', async () => {
    // The unique index is the real guarantee; the app check can be stale.
    stateRef.current.lineInsertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "shift_settlement_lines_shift_key"',
    };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'lost-race' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('says plainly when the unwind ITSELF fails, because an empty payment is then on the books', async () => {
    stateRef.current.lineInsertError = { message: 'nope' };
    stateRef.current.settlementDeleteError = { message: 'also nope' };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toThrow(/covering nothing and must be voided by hand/);
  });

  it('refuses to return when fewer lines LAND than were sent', async () => {
    // Both shifts belong to crew-1 on purpose. An earlier version of this
    // test used another person's shift, so it refused on ownership and never
    // reached the assertion its own name describes — a passing test that
    // proved nothing about the short-insert case.
    stateRef.current.lineInsertReturnsFewer = true;
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(
      recordShiftSettlement({ ...base, shiftIds: ['shift-1', 'shift-2'] }),
    ).rejects.toThrow(/but 1 landed/);
  });

  it('tells the person their pay record moved, and never fails the payment when that note does not send', async () => {
    sendTelegramMock.mockRejectedValueOnce(new Error('telegram down'));
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement(base);
    expect(out.totalCents).toBe(4000);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing to somebody with no Telegram account linked', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await recordShiftSettlement({ ...base, crewMemberId: 'crew-2', shiftIds: ['shift-theirs'] });
    expect(sendTelegramMock).not.toHaveBeenCalled();
  });
});

describe('voidShiftSettlement', () => {
  async function recordOne() {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    return recordShiftSettlement(base);
  }

  it('releases the shift and stops the payment counting', async () => {
    const created = await recordOne();
    const { voidShiftSettlement, summarize, listSettlements } = await import('./shiftSettlements');
    const voided = await voidShiftSettlement({
      settlementId: created.id,
      voidedBy: 'Jason (jason@x)',
      reason: 'wrong person',
    });
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('wrong person');
    expect(stateRef.current.lines.every((l) => l.voided_at !== null)).toBe(true);
    expect(summarize(await listSettlements('crew-1')).settledCents).toBe(0);
  });

  it('makes the shift payable again', async () => {
    const created = await recordOne();
    const { voidShiftSettlement, recordShiftSettlement } = await import('./shiftSettlements');
    await voidShiftSettlement({ settlementId: created.id, voidedBy: 'Jason', reason: 'wrong person' });
    const again = await recordShiftSettlement({ ...base, totalCents: 3600 });
    expect(again.totalCents).toBe(3600);
  });

  it('is idempotent: undoing twice keeps the FIRST reason and actor', async () => {
    const created = await recordOne();
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await voidShiftSettlement({ settlementId: created.id, voidedBy: 'Ann', reason: 'first reason' });
    const second = await voidShiftSettlement({
      settlementId: created.id,
      voidedBy: 'Jason',
      reason: 'second reason',
    });
    expect(second.voidReason).toBe('first reason');
    expect(second.voidedBy).toBe('Ann');
  });

  it('REQUIRES a reason', async () => {
    const created = await recordOne();
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await expect(
      voidShiftSettlement({ settlementId: created.id, voidedBy: 'Jason', reason: '   ' }),
    ).rejects.toThrow(/why/i);
  });

  it('changes NOTHING when the shifts cannot be released, and says so', async () => {
    const created = await recordOne();
    stateRef.current.lineUpdateError = { message: 'connection reset' };
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await expect(
      voidShiftSettlement({ settlementId: created.id, voidedBy: 'Jason', reason: 'oops' }),
    ).rejects.toThrow(/nothing was undone/);
    expect(stateRef.current.lines.every((l) => l.voided_at === null)).toBe(true);
    expect(stateRef.current.settlements[0]!.voided_at).toBeNull();
  });

  it('says the undo is HALF DONE when the shifts released but the payment did not stamp, and re-running finishes it', async () => {
    const created = await recordOne();
    stateRef.current.settlementUpdateError = { message: 'connection reset' };
    const { voidShiftSettlement, summarize, listSettlements } = await import('./shiftSettlements');
    await expect(
      voidShiftSettlement({ settlementId: created.id, voidedBy: 'Jason', reason: 'oops' }),
    ).rejects.toThrow(/run the undo again/);

    // The state the technical lens found: shifts released, payment still live.
    // It must NOT count toward what this person has been paid.
    const summary = summarize(await listSettlements('crew-1'));
    expect(summary.settledCents).toBe(0);
    expect(summary.halfUndone).toEqual([created.id]);

    // Re-running finishes it, because the line update is a no-op the second time.
    stateRef.current.settlementUpdateError = null;
    const done = await voidShiftSettlement({
      settlementId: created.id,
      voidedBy: 'Jason',
      reason: 'oops',
    });
    expect(done.voidedAt).not.toBeNull();
    expect(summarize(await listSettlements('crew-1')).halfUndone).toEqual([]);
  });

  it('tells the person their payment was undone, and says why', async () => {
    // The delta-verify on this PR proved the gap by probe: removing the
    // void-path notify broke NO test, while its record-path sibling was
    // pinned. A future refactor could have dropped the notice silently.
    const created = await recordOne();
    sendTelegramMock.mockClear();
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await voidShiftSettlement({
      settlementId: created.id,
      voidedBy: 'Jason (jason@x)',
      reason: 'wrong person',
    });
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendTelegramMock.mock.calls[0]!;
    // Sent to the person the money was recorded against, not to the actor.
    expect(chatId).toBe('555');
    expect(text).toContain('wrong person');
    expect(text).toContain('$40.00');
  });

  it('does not notify a second time when the same payment is undone twice', async () => {
    const created = await recordOne();
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await voidShiftSettlement({ settlementId: created.id, voidedBy: 'Ann', reason: 'first' });
    sendTelegramMock.mockClear();
    await voidShiftSettlement({ settlementId: created.id, voidedBy: 'Jason', reason: 'second' });
    expect(sendTelegramMock).not.toHaveBeenCalled();
  });

  it('never fails the undo because the note could not be sent', async () => {
    const created = await recordOne();
    sendTelegramMock.mockRejectedValueOnce(new Error('telegram down'));
    const { voidShiftSettlement } = await import('./shiftSettlements');
    const voided = await voidShiftSettlement({
      settlementId: created.id,
      voidedBy: 'Jason',
      reason: 'oops',
    });
    expect(voided.voidedAt).not.toBeNull();
  });

  it('refuses an id that is not a payment', async () => {
    const { voidShiftSettlement } = await import('./shiftSettlements');
    await expect(
      voidShiftSettlement({ settlementId: 'nope', voidedBy: 'Jason', reason: 'oops' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
