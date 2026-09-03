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
  /** Optional so the pre-migration fixtures in this file stay valid: a line
   * written before 2026-09-03 carried no shift total. */
  shift_total_seconds?: number;
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
        const sorts: { col: string; asc: boolean }[] = [];
        const b = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return b;
          },
          // `.not('clock_out_at', 'is', null)` — the OPEN-shift exclusion.
          not: (col: string, op: string, val: unknown) => {
            if (op === 'is' && val === null) {
              list = list.filter((r) => (r as unknown as Record<string, unknown>)[col] !== null);
            }
            return b;
          },
          // MULTI-KEY, like Postgres. Applying each .order() as its own sort
          // would let the second key throw the first away, which is exactly
          // what happened here first time: ordering by (clock_in_at, id)
          // came out ordered by id alone and the oldest-first rule looked
          // broken when it was not.
          order: (col: string, opts?: { ascending?: boolean }) => {
            sorts.push({ col, asc: opts?.ascending !== false });
            return b;
          },
          range: (from: number) => {
            const sorted = [...list].sort((x, y) => {
              for (const s of sorts) {
                const a = String((x as unknown as Record<string, unknown>)[s.col] ?? '');
                const c = String((y as unknown as Record<string, unknown>)[s.col] ?? '');
                if (a !== c) return s.asc ? a.localeCompare(c) : c.localeCompare(a);
              }
              return 0;
            });
            return Promise.resolve({ data: from === 0 ? sorted.map((r) => ({ ...r })) : [], error: null });
          },
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
              // The real guarantee is now the 2026-09-03 TRIGGER, not a
              // unique index: live lines against one shift may not sum past
              // that shift's hours. Modelled here so a double-submit is
              // refused for the reason the database would refuse it, with
              // the check_violation code the caller actually maps.
              for (const row of payload) {
                const live = stateRef.current.lines.filter(
                  (l) => l.shift_id === row.shift_id && l.voided_at === null,
                );
                // The trigger's OTHER refusal, which this fake used to be
                // missing: live lines for one shift must agree on how long
                // that shift is. Without it, a regression test for the
                // edited-under-payment case would pass against a fake that
                // could not produce the failure (technical lens on PR #1190).
                const disagrees = live.some(
                  (l) =>
                    l.shift_total_seconds !== undefined &&
                    l.shift_total_seconds !== Number(row.shift_total_seconds),
                );
                if (disagrees) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: '23514',
                      message: `shift ${String(row.shift_id)} has live settlement lines disagreeing on its length (2 distinct totals)`,
                    },
                  });
                }
                const already = live.reduce((sum, l) => sum + l.paid_seconds, 0);
                const total = Number(row.shift_total_seconds);
                if (already + Number(row.paid_seconds) > total) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: '23514',
                      message: `shift ${String(row.shift_id)} would be paid ${already + Number(row.paid_seconds)} seconds of its ${total}`,
                    },
                  });
                }
              }
              const created = payload.map((row, i) => ({
                id: `line-${stateRef.current.lines.length + i + 1}`,
                settlement_id: String(row.settlement_id),
                shift_id: String(row.shift_id),
                paid_seconds: Number(row.paid_seconds),
                shift_total_seconds: Number(row.shift_total_seconds),
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
  totalCents: 4000,
  paidBy: 'Jason (jason@x)',
  method: 'cash' as const,
};

/** CLOSED_2 (31 Aug, 3h) is OLDER than CLOSED (1 Sep, 4h), so oldest-first
 * spends CLOSED_2 before CLOSED. 7h of work at $9.00/h is worth $63.00. */
const H = 3600;

describe('recordShiftSettlement — the money buys hours, oldest first', () => {
  // crew-1 has two closed shifts: 31 Aug (3h, OLDER) and 1 Sep (4h), plus an
  // open one. 7h at $9.00/h is worth $63.00, which is the ceiling on what any
  // single payment can cover.

  it('spends the amount OLDEST first and leaves the rest owing', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    // $40.00 buys 4h 26m 40s. That is the whole 3h shift and part of the 4h one.
    const out = await recordShiftSettlement({ ...base, totalCents: 4000 });

    expect(out.totalCents).toBe(4000);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]!.shiftId).toBe('shift-2'); // 31 Aug, the older
    expect(out.lines[0]!.paidSeconds).toBe(3 * H);
    expect(out.lines[1]!.shiftId).toBe('shift-1'); // 1 Sep, part paid
    expect(out.lines[1]!.paidSeconds).toBe(16000 - 3 * H);
    // The rollover: what this payment did NOT reach on that shift.
    expect(4 * H - out.lines[1]!.paidSeconds).toBe(4 * H - (16000 - 3 * H));
    expect(out.coveredSeconds).toBe(16000);
  });

  it('the leftover ROLLS OVER: a second payment picks up where the first stopped', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await recordShiftSettlement({ ...base, totalCents: 4000 });

    // 25200 - 16000 = 9200s still owing, worth exactly $23.00.
    const second = await recordShiftSettlement({ ...base, totalCents: 2300 });
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]!.shiftId).toBe('shift-1');
    expect(second.lines[0]!.paidSeconds).toBe(9200);
    // And nothing is left: a third payment has nowhere to go.
    await expect(recordShiftSettlement({ ...base, totalCents: 100 })).rejects.toMatchObject({
      code: 'no-shifts',
    });
  });

  it('stamps the rate, and the reference now AGREES with the amount by construction', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement({ ...base, totalCents: 4000 });
    expect(out.lines[0]!.rateCentsPerHour).toBe(900);
    // Worth being explicit about, because it reverses a phase 3 property.
    // Phase 3 marked whole shifts, so the reference and the amount were free
    // to differ and the design leaned on that. Deriving the hours FROM the
    // money closes the gap: the two now agree to within per-line rounding.
    // Nothing asserts it in the code, and the schema still permits a
    // difference — but no longer expects one.
    expect(Math.abs(out.referenceCents - out.totalCents)).toBeLessThanOrEqual(out.lines.length);
  });

  it('subtracts breaks before spending the money on a shift', async () => {
    stateRef.current.breaks = [
      { shift_id: 'shift-2', started_at: '2026-08-31T13:00:00.000Z', ended_at: '2026-08-31T13:30:00.000Z' },
    ];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement({ ...base, totalCents: 4000 });
    // The older shift is now 2h 30m, so more of the money lands on the newer.
    expect(out.lines[0]!.paidSeconds).toBe(2.5 * H);
    expect(out.lines[1]!.paidSeconds).toBe(16000 - 2.5 * H);
  });

  it('never touches a shift that is still running, even when the money would reach it', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    // The maximum: every closed unpaid hour crew-1 has.
    const out = await recordShiftSettlement({ ...base, totalCents: 6300 });
    expect(out.lines.map((l) => l.shiftId).sort()).toEqual(['shift-1', 'shift-2']);
    // Its hours are still growing, so a payment against it would stamp a
    // reference that was already wrong when it was written.
    expect(out.lines.some((l) => l.shiftId === 'shift-open')).toBe(false);
  });

  it("never touches somebody else's shift", async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement({ ...base, totalCents: 6300 });
    expect(out.lines.some((l) => l.shiftId === 'shift-theirs')).toBe(false);
  });

  it('REFUSES an amount worth more than every unpaid hour, and names the maximum', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    // $63.01 against $63.00 of unpaid work.
    await expect(recordShiftSettlement({ ...base, totalCents: 6301 })).rejects.toMatchObject({
      code: 'over-payment',
    });
    await expect(recordShiftSettlement({ ...base, totalCents: 6301 })).rejects.toThrow(/\$63\.00/);
    // Nothing recorded: the refusal happens before any write.
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('allows the exact maximum, so the last remainder of a week is payable', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement({ ...base, totalCents: 6300 });
    expect(out.coveredSeconds).toBe(7 * H);
  });

  it('REFUSES when the person has no rate, rather than inventing one', async () => {
    stateRef.current.crew[0]!.base_rate_cents = 0;
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'no-rate' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('REFUSES when there is nothing unpaid to put the money against', async () => {
    stateRef.current.shifts = [OPEN, OTHERS];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'no-shifts' });
  });

  it('REFUSES a zero, negative or sub-cent amount, so a payment always records money', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    for (const totalCents of [0, -1, 1.5]) {
      await expect(recordShiftSettlement({ ...base, totalCents })).rejects.toMatchObject({
        code: 'invalid-amount',
      });
    }
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

  it('loses a double-submit to the TRIGGER, and unwinds its own settlement', async () => {
    // 23514, the check_violation the 2026-09-03 trigger raises when two
    // payments would sum past a shift's hours. It replaced the 23505 the old
    // unique index produced; both still map to the same refusal.
    stateRef.current.lineInsertError = {
      code: '23514',
      message: 'shift shift-2 would be paid 20000 seconds of its 10800',
    };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'lost-race' });
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('still loses a double-submit to the OLD unique index, for lines written before the migration', async () => {
    stateRef.current.lineInsertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "shift_settlement_lines_shift_key"',
    };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'lost-race' });
  });

  it('REFUSES with its own message when a shift was edited under a live payment', async () => {
    // The trigger raises check_violation for two different situations, and
    // only one of them is a race. A length disagreement can never be cleared
    // by retrying, so mapping it to "try again" sent an admin round a loop
    // forever on a shift that had quietly become unpayable.
    stateRef.current.lineInsertError = {
      code: '23514',
      message: 'shift shift-2 has live settlement lines disagreeing on its length (2 distinct totals)',
    };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toMatchObject({ code: 'shift-edited' });
    // And the instruction is one that actually works.
    await expect(recordShiftSettlement(base)).rejects.toThrow(/Undo that payment/);
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('lets a remainder worth less than a cent still be cleared', async () => {
    // referenceCentsFor rounds to nearest, so a second or two of remaining
    // time is worth under half a cent and rounds to ZERO. With a zero ceiling
    // no positive amount is ever allowed, and those seconds would be
    // permanently unpayable.
    stateRef.current.shifts = [
      { id: 'tiny', crew_member_id: 'crew-1', clock_in_at: '2026-08-30T12:00:00.000Z', clock_out_at: '2026-08-30T12:00:01.000Z' },
    ];
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement({ ...base, totalCents: 1 });
    expect(out.totalCents).toBe(1);
    expect(out.lines[0]!.paidSeconds).toBe(1);
    // Two cents is still more than one second is worth.
    stateRef.current.settlements = [];
    stateRef.current.lines = [];
    await expect(recordShiftSettlement({ ...base, totalCents: 2 })).rejects.toMatchObject({
      code: 'over-payment',
    });
  });

  it('says plainly when the unwind ITSELF fails, because an empty payment is then on the books', async () => {
    stateRef.current.lineInsertError = { message: 'nope' };
    stateRef.current.settlementDeleteError = { message: 'also nope' };
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await expect(recordShiftSettlement(base)).rejects.toThrow(/covering nothing and must be voided by hand/);
  });

  it('refuses to return when fewer lines LAND than were sent', async () => {
    stateRef.current.lineInsertReturnsFewer = true;
    const { recordShiftSettlement } = await import('./shiftSettlements');
    // $40.00 spans two shifts, so one line can go missing.
    await expect(recordShiftSettlement({ ...base, totalCents: 4000 })).rejects.toThrow(/but 1 landed/);
  });

  it('tells the person in HOURS what was covered, and what is still carried over', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await recordShiftSettlement({ ...base, totalCents: 4000 });
    const text = String(sendTelegramMock.mock.calls[0]![1]);
    // Hours, not "N shifts": a payment can stop part way through one now, so
    // a shift count would overstate what it covered.
    expect(text).toContain('4h 27m');
    expect(text).toContain('still unpaid and carried over');
    expect(text).not.toMatch(/covering \d+ shifts/);
  });

  it('tells the person when nothing is left owing', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await recordShiftSettlement({ ...base, totalCents: 6300 });
    const text = String(sendTelegramMock.mock.calls[0]![1]);
    expect(text).toContain('nothing is left unpaid');
  });

  it('never fails the payment when that note does not send', async () => {
    sendTelegramMock.mockRejectedValueOnce(new Error('telegram down'));
    const { recordShiftSettlement } = await import('./shiftSettlements');
    const out = await recordShiftSettlement(base);
    expect(out.totalCents).toBe(4000);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing to somebody with no Telegram account linked', async () => {
    const { recordShiftSettlement } = await import('./shiftSettlements');
    await recordShiftSettlement({ crewMemberId: 'crew-2', totalCents: 100, paidBy: 'Jason (jason@x)', method: 'wise' });
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
    // And HOW MUCH TIME went back to unpaid. With part payments the amount
    // alone no longer implies which hours moved, and leaving this out made
    // the person better informed when they were paid than when a payment was
    // taken back (staff lens on PR #1190). $40.00 at $9.00/h bought 4h 27m.
    expect(text).toContain('4h 27m of your time goes back to unpaid');
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
