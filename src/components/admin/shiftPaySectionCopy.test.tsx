// What the "Payments recorded" list SAYS about a past settlement.
//
// Narrow on purpose: one sentence, which ledger row 506 made capable of
// lying. A settlement used to cover hours that were all worth the same, so
// "$X at the stamped rate" was true by construction. Since a payment can now
// reach across a raise, its lines can carry two different rates, and the
// singular names a rate half those hours were never paid at (staff lens on
// PR #1214) — the guard-and-copy class AGENTS.md calls out.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

import type { ShiftSettlement, ShiftSettlementLine } from '@/lib/shiftSettlements';
import { ShiftPaySection } from './PersonHoursSections';

const H = 3600;

function line(over: Partial<ShiftSettlementLine> & { id: string }): ShiftSettlementLine {
  return {
    shiftId: `shift-${over.id}`,
    paidSeconds: 4 * H,
    rateCentsPerHour: 1300,
    referenceCents: 5200,
    voidedAt: null,
    ...over,
  };
}

function settlement(lines: ShiftSettlementLine[], totalCents: number): ShiftSettlement {
  return {
    id: 'st-1',
    crewMemberId: 'crew-1',
    totalCents,
    method: 'cash',
    note: null,
    paidAt: '2026-09-04T13:00:00.000Z',
    paidBy: 'Jason',
    createdAt: '2026-09-04T13:00:00.000Z',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    lines,
    coveredSeconds: lines.reduce((n, l) => n + l.paidSeconds, 0),
    referenceCents: lines.reduce((n, l) => n + l.referenceCents, 0),
  };
}

function render(st: ShiftSettlement): string {
  return renderToStaticMarkup(
    <ShiftPaySection
      crewMemberId="crew-1"
      crewName="Jason"
      remainders={[]}
      settlements={[st]}
      settledCents={st.totalCents}
      settlementsReadable
      halfUndone={[]}
    />,
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('a recorded payment reports its rates honestly', () => {
  it('says "rate" when every hour it covered was worth the same', () => {
    // 8h at $13.00 is $104.00 of hours against $200.00 handed over — a real
    // gap (a bonus), which is what makes the sentence render at all.
    const st = settlement([line({ id: 'a' }), line({ id: 'b' })], 20000);
    const out = text(render(st));
    expect(out).toContain('$104.00 at the stamped rate');
  });

  it('says "rates" when the payment spanned a raise', () => {
    const st = settlement(
      [line({ id: 'a', rateCentsPerHour: 1300, referenceCents: 5200 }),
       line({ id: 'b', rateCentsPerHour: 1600, referenceCents: 6400 })],
      20000,
    );
    const out = text(render(st));
    expect(out).toContain('$116.00 at the stamped rates');
    expect(out).not.toContain('at the stamped rate ');
  });

  it('ignores a VOIDED line when deciding, since it covers nothing now', () => {
    // A voided line at a different rate must not make a single-rate payment
    // describe itself as spanning two.
    const st = settlement(
      [line({ id: 'a', rateCentsPerHour: 1300, referenceCents: 5200 }),
       line({ id: 'b', rateCentsPerHour: 1600, referenceCents: 6400, voidedAt: '2026-09-04T14:00:00.000Z' })],
      20000,
    );
    expect(text(render(st))).toContain('at the stamped rate');
  });
});
