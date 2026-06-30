import { describe, it, expect } from 'vitest';
import { decideInboxState } from './reducer';
import type { ExistingItemState } from './reducer';
import type { NormalizedTouch } from './types';

const HOUR = 3_600_000;
const T = new Date('2026-06-28T15:00:00Z');
const at = (ms: number) => new Date(T.getTime() + ms);

function touch(over: Partial<NormalizedTouch> = {}): NormalizedTouch {
  return {
    source: 'ghl',
    externalId: 'conv-1',
    direction: 'inbound',
    channel: 'sms',
    lastMessageAt: T,
    preview: 'hello',
    identity: { ghlContactId: 'g1', emails: [], phones: [] },
    ...over,
  };
}

describe('decideInboxState — new inbound touch', () => {
  it('opens an unresponded item with a display escalation level by age', () => {
    const d = decideInboxState({ existing: null, touch: touch(), now: at(2 * HOUR) });
    expect(d.status).toBe('unresponded');
    expect(d.escalationLevel).toBe(1); // amber, for sorting/colour only
    expect(d.reopened).toBe(false);
    expect(d.autoResolved).toBe(false);
  });

  it('has no escalation level when fresh (<1h)', () => {
    const d = decideInboxState({ existing: null, touch: touch(), now: at(20 * 60_000) });
    expect(d.status).toBe('unresponded');
    expect(d.escalationLevel).toBe(0);
  });
});

describe('decideInboxState — outbound auto-resolve', () => {
  it('auto-resolves an open item when the latest message is outbound', () => {
    const existing: ExistingItemState = { status: 'unresponded', notifiedLevels: [1, 2] };
    const d = decideInboxState({ existing, touch: touch({ direction: 'outbound' }), now: at(6 * HOUR) });
    expect(d.status).toBe('handled');
    expect(d.autoResolved).toBe(true);
    expect(d.escalationLevel).toBe(0);
  });

  it('treats a we-initiated outbound (no existing) as already handled', () => {
    const d = decideInboxState({ existing: null, touch: touch({ direction: 'outbound' }), now: at(HOUR) });
    expect(d.status).toBe('handled');
    expect(d.autoResolved).toBe(true);
  });
});

describe('decideInboxState — reopen on new inbound', () => {
  it('reopens a handled item (the store then resets its escalation clock)', () => {
    const existing: ExistingItemState = { status: 'handled', notifiedLevels: [1, 2] };
    const d = decideInboxState({ existing, touch: touch(), now: at(10 * 60_000) });
    expect(d.status).toBe('unresponded');
    expect(d.reopened).toBe(true);
    expect(d.escalationLevel).toBe(0);
  });

  it('does NOT reopen a handled item when the inbound is the SAME message (reconcile re-ingest)', () => {
    const existing: ExistingItemState = { status: 'handled', notifiedLevels: [1, 2], lastMessageAt: T };
    const d = decideInboxState({ existing, touch: touch({ lastMessageAt: T }), now: at(2 * HOUR) });
    expect(d.status).toBe('handled');
    expect(d.reopened).toBe(false);
    expect(d.escalationLevel).toBe(0);
  });

  it('reopens a handled item only when a NEWER inbound arrives', () => {
    const existing: ExistingItemState = { status: 'handled', notifiedLevels: [1, 2], lastMessageAt: T };
    const d = decideInboxState({ existing, touch: touch({ lastMessageAt: at(3 * HOUR) }), now: at(4 * HOUR) });
    expect(d.status).toBe('unresponded');
    expect(d.reopened).toBe(true);
  });
});

describe('decideInboxState — dismissed is sticky', () => {
  it('keeps a dismissed item dismissed on a new inbound (spam stays out)', () => {
    const existing: ExistingItemState = { status: 'dismissed', notifiedLevels: [] };
    const d = decideInboxState({ existing, touch: touch(), now: at(8 * HOUR) });
    expect(d.status).toBe('dismissed');
    expect(d.escalationLevel).toBe(0);
    expect(d.reopened).toBe(false);
    expect(d.autoResolved).toBe(false);
  });

  it('keeps dismissed even when an outbound arrives', () => {
    const existing: ExistingItemState = { status: 'dismissed', notifiedLevels: [] };
    const d = decideInboxState({ existing, touch: touch({ direction: 'outbound' }), now: at(HOUR) });
    expect(d.status).toBe('dismissed');
    expect(d.autoResolved).toBe(false);
  });
});
