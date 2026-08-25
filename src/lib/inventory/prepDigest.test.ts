import { describe, it, expect } from 'vitest';
import { groupPrepCards, prepDigestMessage, stuckStockSnapshotCards } from './prepDigest';
import type { FulfillmentCard } from './jobs';

function card(over: Partial<FulfillmentCard>): FulfillmentCard {
  return {
    id: 'id-' + Math.random(),
    jobNumber: 1,
    quoteId: null,
    designId: null,
    stage: 'to_be_ordered',
    status: 'to_schedule',
    customerName: 'Jane Doe',
    customerAddress: null,
    itemCount: 0,
    installDate: null,
    isTest: false,
    highlevelContactId: null,
    customerId: null,
    stockSnapshotPending: false,
    ...over,
  };
}

describe('groupPrepCards', () => {
  it('buckets by stage, board column order, only stages with cards present', () => {
    const cards = [
      card({ stage: 'to_be_prepared' }),
      card({ stage: 'to_be_ordered' }),
      card({ stage: 'ready_for_install' }), // NOT prep — excluded
      card({ stage: 'awaiting_pickup' }),
    ];
    const grouped = groupPrepCards(cards);
    expect(Object.keys(grouped)).toEqual(['to_be_ordered', 'awaiting_pickup', 'to_be_prepared']);
    expect(grouped.ready_for_install).toBeUndefined();
  });

  it('omits a stage entirely when it has no cards', () => {
    const grouped = groupPrepCards([card({ stage: 'to_be_ordered' })]);
    expect(grouped.awaiting_pickup).toBeUndefined();
    expect(grouped.to_be_prepared).toBeUndefined();
  });
});

describe('prepDigestMessage', () => {
  it('sends a one-line all-clear when nothing is waiting', () => {
    const msg = prepDigestMessage([], 'https://app.example.com');
    expect(msg).toBe('✅ Prep board clear — nothing waiting.');
  });

  it('sends a one-line all-clear when only ready_for_install cards are on the board', () => {
    const msg = prepDigestMessage([card({ stage: 'ready_for_install' })], 'https://app.example.com');
    expect(msg).toBe('✅ Prep board clear — nothing waiting.');
  });

  it('groups by stage with a label, "#<job_number> <customer>" lines, and a board link', () => {
    const cards = [
      card({ stage: 'to_be_ordered', jobNumber: 101, customerName: 'Alice Smith' }),
      card({ stage: 'to_be_prepared', jobNumber: 202, customerName: 'Bob Jones' }),
    ];
    const msg = prepDigestMessage(cards, 'https://app.example.com');
    expect(msg).toContain('2 job(s) waiting');
    expect(msg).toContain('To Be Ordered:');
    expect(msg).toContain('#101 Alice Smith');
    expect(msg).toContain('To Be Prepared:');
    expect(msg).toContain('#202 Bob Jones');
    expect(msg).toContain('Board → https://app.example.com/inventory/jobs');
    // stage order preserved: to_be_ordered before to_be_prepared
    expect(msg.indexOf('To Be Ordered:')).toBeLessThan(msg.indexOf('To Be Prepared:'));
  });

  it('falls back to "Customer" when the name is missing/blank, and "—" when job number is missing', () => {
    const msg = prepDigestMessage(
      [card({ jobNumber: null, customerName: null }), card({ jobNumber: 5, customerName: '   ' })],
      'https://app.example.com',
    );
    expect(msg).toContain('#— Customer');
    expect(msg).toContain('#5 Customer');
  });

  it('caps the job-line count and appends a "…and N more" note instead of truncating mid-line', () => {
    const cards = Array.from({ length: 45 }, (_, i) => card({ jobNumber: i + 1, stage: 'to_be_ordered' }));
    const msg = prepDigestMessage(cards, 'https://app.example.com');
    expect(msg).toContain('45 job(s) waiting');
    expect(msg).toContain('#40 Jane Doe'); // the 40th shown
    expect(msg).not.toContain('#41 Jane Doe'); // the 41st is omitted
    expect(msg).toContain('…and 5 more');
    expect(msg.length).toBeLessThan(4000);
  });

  // Row 382: a job stuck at PENDING_STOCK_SNAPSHOT has already advanced to
  // 'ready_for_install' — excluded from PREP_STAGES/groupPrepCards above — so
  // without a dedicated pass it stays invisible to this digest forever.
  describe('stuck stock-snapshot jobs (row 382)', () => {
    it('lists a stuck job even when the prep board itself is otherwise clear', () => {
      const msg = prepDigestMessage(
        [card({ stage: 'ready_for_install', jobNumber: 77, customerName: 'Stuck Customer', stockSnapshotPending: true })],
        'https://app.example.com',
      );
      // The all-clear line is still accurate (nothing is WAITING to be
      // prepped) — the stuck-job line rides alongside it, not instead of it,
      // so a quiet prep board never hides this.
      expect(msg).toContain('Prep board clear');
      expect(msg).toContain("1 job(s) prepped but the per-job snapshot failed to save");
      expect(msg).toContain('#77 Stuck Customer');
      expect(msg).toContain('Board → https://app.example.com/inventory/jobs');
    });

    it('appends the stuck-job line alongside a normal non-empty prep board', () => {
      const msg = prepDigestMessage(
        [
          card({ stage: 'to_be_ordered', jobNumber: 1, customerName: 'Alice' }),
          card({ stage: 'ready_for_install', jobNumber: 2, customerName: 'Bob', stockSnapshotPending: true }),
        ],
        'https://app.example.com',
      );
      expect(msg).toContain('1 job(s) waiting');
      expect(msg).toContain('#1 Alice');
      expect(msg).toContain("1 job(s) prepped but the per-job snapshot failed to save");
      expect(msg).toContain('#2 Bob');
    });

    it('says nothing about stuck jobs when none exist (unchanged all-clear)', () => {
      const msg = prepDigestMessage([], 'https://app.example.com');
      expect(msg).toBe('✅ Prep board clear — nothing waiting.');
    });
  });
});

describe('stuckStockSnapshotCards', () => {
  it('filters to only cards with stockSnapshotPending', () => {
    const stuck = card({ stockSnapshotPending: true, jobNumber: 5 });
    const fine = card({ stockSnapshotPending: false, jobNumber: 6 });
    expect(stuckStockSnapshotCards([stuck, fine])).toEqual([stuck]);
  });
});
