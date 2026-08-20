import { describe, it, expect } from 'vitest';
import { resolveAgreedTotal, amendedAgreedTotal } from './agreedTotal';

// The AGREED total precedence must match amend/route.ts's previousTotal chain
// EXACTLY: last amendment new_total ?? snapshot currentTotalUsd ?? result.total ?? 0.

describe('resolveAgreedTotal', () => {
  it('prefers the last amendment new_total (rung 1)', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: [{ new_total: 5600 }, { new_total: 5200 }],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5200);
  });

  it('falls back to the snapshot selection total when no amendments (rung 2)', () => {
    const snap = { customerSelection: { currentTotalUsd: 5000 }, amendments: [] };
    expect(resolveAgreedTotal(snap, { total: 5600 })).toBe(5000);
  });

  it('falls back to result.total when no snapshot (rung 3 — legacy row)', () => {
    expect(resolveAgreedTotal(null, { total: 4893.75 })).toBe(4893.75);
    expect(resolveAgreedTotal({}, { total: 4893.75 })).toBe(4893.75);
  });

  it('falls back to 0 when nothing is priceable (rung 4)', () => {
    expect(resolveAgreedTotal(null, null)).toBe(0);
    expect(resolveAgreedTotal(null, undefined)).toBe(0);
    expect(resolveAgreedTotal({}, {})).toBe(0);
  });

  it('the selection total (rung 2) can be BELOW result.total — the diverged case', () => {
    // Customer deselected an item / picked the cheaper roofline tier.
    const snap = { customerSelection: { currentTotalUsd: 3697.5 } };
    expect(resolveAgreedTotal(snap, { total: 5437.5 })).toBe(3697.5);
  });

  it('tolerates a malformed selection total (falls through to result.total)', () => {
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: NaN } }, { total: 100 })).toBe(100);
    expect(
      resolveAgreedTotal({ customerSelection: { currentTotalUsd: 'x' as unknown as number } }, { total: 100 }),
    ).toBe(100);
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: -5 } }, { total: 100 })).toBe(100);
    expect(resolveAgreedTotal({ customerSelection: null }, { total: 100 })).toBe(100);
  });

  it('tolerates a malformed trailing amendment and walks back to an earlier valid one', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: [{ new_total: 5600 }, { new_total: NaN }],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5600);
  });

  it('tolerates a non-array amendments field (falls through to selection)', () => {
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      amendments: 'oops' as unknown as [],
    };
    expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(5000);
  });

  it('accepts 0 as a valid agreed total (a fully-discounted / waived selection)', () => {
    expect(resolveAgreedTotal({ customerSelection: { currentTotalUsd: 0 } }, { total: 500 })).toBe(0);
  });

  // Review HIGH (ledger #83 decline follow-up): a DECLINED amendment must
  // never be picked up as "the agreed total" — the customer explicitly
  // refused it. Every shape below is a real trail an operator can produce.
  describe('a DECLINED amendment is never the agreed total', () => {
    it('a lone declined-latest amendment falls back to the prior (accepted) amendment', () => {
      const snap = {
        customerSelection: { currentTotalUsd: 2000 },
        amendments: [
          { new_total: 2400, consent: { status: 'accepted' } },
          { new_total: 2800, consent: { status: 'declined' } },
        ],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2400);
    });

    it('a lone declined amendment with no prior amendment falls back to the selection total', () => {
      const snap = {
        customerSelection: { currentTotalUsd: 2000 },
        amendments: [{ new_total: 2400, consent: { status: 'declined' } }],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2000);
    });

    it('TWO declines in a row both skip, falling back to the selection total', () => {
      const snap = {
        customerSelection: { currentTotalUsd: 2000 },
        amendments: [
          { new_total: 2400, consent: { status: 'declined' } },
          { new_total: 2900, consent: { status: 'declined' } },
        ],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2000);
    });

    it('accepted THEN declined: the declined entry is skipped, the earlier accepted one wins', () => {
      const snap = {
        amendments: [
          { new_total: 2400, consent: { status: 'accepted' } },
          { new_total: 1900, consent: { status: 'declined' } }, // a declined DECREASE
        ],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2400);
    });

    it('declined THEN accepted: the later acceptance is the live agreed total', () => {
      const snap = {
        amendments: [
          { new_total: 2900, consent: { status: 'declined' } },
          { new_total: 2600, consent: { status: 'accepted' } },
        ],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2600);
    });

    it('a PENDING latest amendment is still picked up (unchanged, deliberate — not the decline fix)', () => {
      const snap = {
        customerSelection: { currentTotalUsd: 2000 },
        amendments: [{ new_total: 2400, consent: { status: 'pending' } }],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2400);
    });

    it('a legacy amendment with no consent field at all is still picked up (not declined)', () => {
      const snap = {
        customerSelection: { currentTotalUsd: 2000 },
        amendments: [{ new_total: 2400 }],
      };
      expect(resolveAgreedTotal(snap, { total: 9999 })).toBe(2400);
    });
  });
});

describe('amendedAgreedTotal', () => {
  const agreed = 5000; // customer approved a $5,000 selection of a $5,600 full quote

  it('returns the agreed total unchanged when the full quote did not move (no phantom increase)', () => {
    // No builder edit: current full total === the approval-time full total.
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5600 }, agreed)).toBe(agreed);
  });

  it('applies an amend-UP shift on the agreed basis (staff added $300 of work)', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5900 }, agreed)).toBe(5300); // 5000 + (5900 − 5600)
  });

  it('applies an amend-DOWN shift on the agreed basis (staff removed $400 of work)', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 5200 }, agreed)).toBe(4600); // 5000 + (5200 − 5600)
  });

  it('clamps to 0 when the removal exceeds the agreed total', () => {
    const snap = { pricing: { total: 5600 } };
    expect(amendedAgreedTotal(snap, { total: 0 }, agreed)).toBe(0); // 5000 + (0 − 5600) < 0 → 0
  });

  it('falls back to the current full total when the snapshot has no frozen full total (legacy)', () => {
    // No pricing.total → measure on the full basis (pre-fix behavior, safe for
    // the non-diverged path where agreed == full).
    expect(amendedAgreedTotal({}, { total: 5600 }, agreed)).toBe(5600);
    expect(amendedAgreedTotal({ pricing: null }, { total: 5600 }, agreed)).toBe(5600);
  });

  it('returns the agreed total when there is no current result to measure', () => {
    expect(amendedAgreedTotal({ pricing: { total: 5600 } }, null, agreed)).toBe(agreed);
    expect(amendedAgreedTotal({ pricing: { total: 5600 } }, { total: NaN }, agreed)).toBe(agreed);
  });

  // ── Sequential amendments must each bill ONLY their own increment. The shift
  // basis is the frozen approval full total PLUS the amendments already applied,
  // not the raw snapshot.pricing.total — otherwise a 2nd amendment re-includes the
  // 1st amendment's change (double-count).
  it('a SECOND amendment measures only its own increment (no double-count) — $8k, +$500 then +$300', () => {
    // $8,000 agreed (no selection divergence: agreed == full == $8,000).
    // First amendment took the full quote to $8,500 (+$500), recorded as
    // { new_total: 8500, delta: 500 }. Now staff amends again, taking the full
    // quote to $8,800 — only +$300 of NEW work. Final agreed must be $8,800
    // (delta $300 off the $8,500 prior agreed), NOT $9,300 (which would re-add the
    // first amendment's $500).
    const snap = {
      pricing: { total: 8000 },
      amendments: [{ new_total: 8500, delta: 500 }],
    };
    const priorAgreed = 8500; // = last amendment new_total (resolveAgreedTotal)
    expect(amendedAgreedTotal(snap, { total: 8800 }, priorAgreed)).toBe(8800);
  });

  it('sequential amendments on a DIVERGED selection still measure only the new increment', () => {
    // Approval: $5,000 selection of a $5,600 full quote. First amendment took the
    // full quote to $5,900 (+$300 real work) → agreed $5,300. Second amendment
    // takes the full quote to $6,100 (+$200 more) → agreed must be $5,500
    // ($5,000 + $300 + $200), NOT $5,800 (which would re-add the first $300).
    const snap = {
      customerSelection: { currentTotalUsd: 5000 },
      pricing: { total: 5600 },
      amendments: [{ new_total: 5300, delta: 300 }],
    };
    const priorAgreed = 5300;
    expect(amendedAgreedTotal(snap, { total: 6100 }, priorAgreed)).toBe(5500);
  });

  it('a THIRD amendment sums ALL prior deltas into the basis', () => {
    // agreed $10,000 == full. Two prior amendments: +$1,000 then −$400
    // (deltas 1000, −400 → agreed now $10,600). Third takes full to $11,200
    // (net +$600 of full-total change from $10,000): basis = 10000 + 600 = 10600,
    // current full 11200 → shift +$600 → agreed $11,200.
    const snap = {
      pricing: { total: 10000 },
      amendments: [
        { new_total: 11000, delta: 1000 },
        { new_total: 10600, delta: -400 },
      ],
    };
    const priorAgreed = 10600;
    expect(amendedAgreedTotal(snap, { total: 11200 }, priorAgreed)).toBe(11200);
  });

  // Delta-verify (fix-round self-check, ledger #83 decline follow-up): a
  // declined amendment's delta must NOT count as "already applied" in the
  // basis, or a second amendment after a decline mis-measures its own shift —
  // see the exact worked numbers in the function's own comment.
  describe('a DECLINED amendment is excluded from the applied-delta basis', () => {
    it('staff REMOVE the declined item afterward: reads as no-change, not a phantom discount', () => {
      // $5,600 full / $5,000 agreed. Amendment 1 added a $900 item (declined):
      // full moved to $6,500, but the customer said no, so agreedTotal (via
      // resolveAgreedTotal) is still $5,000. Staff then remove that item in the
      // builder — full reverts to $5,600 — and record amendment 2.
      const snap = {
        pricing: { total: 5600 },
        amendments: [{ new_total: 6500, delta: 900, consent: { status: 'declined' } }],
      };
      const agreedAfterDecline = 5000; // resolveAgreedTotal skips the declined entry
      expect(amendedAgreedTotal(snap, { total: 5600 }, agreedAfterDecline)).toBe(5000);
    });

    it('staff RE-OFFER the same declined item: the full amount is asked for again, not silently re-granted', () => {
      // Same setup, but staff leave the declined $900 item in the builder and
      // add $200 more of new work — full is now $6,700 (5600 + 900 + 200).
      const snap = {
        pricing: { total: 5600 },
        amendments: [{ new_total: 6500, delta: 900, consent: { status: 'declined' } }],
      };
      const agreedAfterDecline = 5000;
      // basis excludes the declined $900 → basis 5600; shift = 6700 − 5600 = 1100
      // → 5000 + 1100 = 6100 (re-asks for both the re-offered $900 AND the new $200).
      expect(amendedAgreedTotal(snap, { total: 6700 }, agreedAfterDecline)).toBe(6100);
    });

    it('a declined amendment sandwiched between two accepted ones excludes only its own delta', () => {
      // agreed $10,000 == full. Amendment 1: +$1,000 (accepted, agreed → $11,000).
      // Amendment 2: +$500 (DECLINED — never applied). Amendment 3 (this call):
      // full moves to $11,600 (net +$600 from the $11,000 base the accepted
      // amendment 1 left, since the declined amendment 2 never touched the
      // builder's committed scope). basis excludes amendment 2's $500 → basis =
      // 10000 + 1000 = 11000; shift = 11600 − 11000 = 600 → 11000 + 600 = 11600.
      const snap = {
        pricing: { total: 10000 },
        amendments: [
          { new_total: 11000, delta: 1000, consent: { status: 'accepted' } },
          { new_total: 11500, delta: 500, consent: { status: 'declined' } },
        ],
      };
      const priorAgreed = 11000; // resolveAgreedTotal skips the declined entry, lands on the accepted one
      expect(amendedAgreedTotal(snap, { total: 11600 }, priorAgreed)).toBe(11600);
    });
  });
});
