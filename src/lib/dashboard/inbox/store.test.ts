import { describe, it, expect } from 'vitest';
import { planIngest } from './store';
import type { ExistingItem } from './store';
import type { NormalizedTouch, StoredContact } from './types';

const T = new Date('2026-06-28T15:00:00Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const HOUR = 3_600_000;

function touch(over: Partial<NormalizedTouch> = {}): NormalizedTouch {
  return {
    source: 'ghl',
    externalId: 'conv-1',
    direction: 'inbound',
    channel: 'sms',
    lastMessageAt: T,
    preview: 'hello',
    identity: { ghlContactId: 'g1', emails: ['jane@example.com'], phones: [], displayName: 'Jane' },
    ...over,
  };
}
function contact(over: Partial<StoredContact>): StoredContact {
  return { id: 'c1', ghlContactId: null, emails: [], phones: [], displayName: null, ...over };
}

describe('planIngest — new conversation, no existing item', () => {
  it('plans a fresh contact insert + an unresponded item when nobody matches', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(2 * HOUR) });
    expect(plan.contactOp.kind).toBe('insert');
    expect(plan.ambiguous).toBe(false);
    expect(plan.item.status).toBe('unresponded');
    expect(plan.item.source).toBe('ghl');
    expect(plan.item.external_id).toBe('conv-1');
    expect(plan.item.escalation_level).toBe(1); // display level for sorting/colour
    expect(plan.item.last_message_at).toBe(T.toISOString()); // serialized ISO
  });

  it('plans a contact UPDATE (append identifiers) when one candidate matches', () => {
    const candidate = contact({ id: 'A', emails: ['jane@example.com'] });
    const plan = planIngest({ candidates: [candidate], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.contactOp.kind).toBe('update');
    if (plan.contactOp.kind === 'update') {
      expect(plan.contactOp.contactId).toBe('A');
      expect(plan.contactOp.merged.ghlContactId).toBe('g1'); // appended from the touch
      expect(plan.contactOp.merged.emails).toContain('jane@example.com');
    }
  });

  it('inserts a FRESH contact (never auto-merges) and flags ambiguous when identifiers split across two contacts', () => {
    const candidates = [
      contact({ id: 'A', emails: ['jane@example.com'] }),
      contact({ id: 'B', phones: ['+16315551234'] }),
    ];
    const plan = planIngest({
      candidates,
      existing: null,
      touch: touch({ identity: { ghlContactId: null, emails: ['jane@example.com'], phones: ['631-555-1234'] } }),
      now: at(HOUR),
    });
    expect(plan.ambiguous).toBe(true);
    expect(plan.contactOp.kind).toBe('insert');
  });
});

describe('planIngest — existing item keeps its contact link', () => {
  it('keeps the linked contact and reopens a handled item on new inbound', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'handled', notifiedLevels: [1, 2] };
    const plan = planIngest({ candidates: [], existing, touch: touch(), now: at(10 * 60_000) });
    expect(plan.contactOp.kind).toBe('keep');
    if (plan.contactOp.kind === 'keep') expect(plan.contactOp.contactId).toBe('A');
    expect(plan.reopened).toBe(true);
    expect(plan.item.status).toBe('unresponded');
    expect(plan.item.notified_levels).toEqual([]); // escalation clock reset
  });

  it('auto-resolves on an outbound touch', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [1] };
    const plan = planIngest({ candidates: [], existing, touch: touch({ direction: 'outbound' }), now: at(6 * HOUR) });
    expect(plan.item.status).toBe('handled');
    expect(plan.autoResolved).toBe(true);
    expect(plan.skip).toBe(false); // existing item → must persist the auto-resolve
  });
});

describe('planIngest — skip outbound-with-no-existing (avoid noise)', () => {
  it('skips an outbound touch that has no existing item (we cold-contacted; nothing to track)', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch({ direction: 'outbound' }), now: at(HOUR) });
    expect(plan.skip).toBe(true);
  });
  it('never skips an inbound touch', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.skip).toBe(false);
  });
});
