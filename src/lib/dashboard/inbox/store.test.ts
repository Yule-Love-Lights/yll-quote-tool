import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'handled', notifiedLevels: [1, 2], lastMessageAt: null };
    const plan = planIngest({ candidates: [], existing, touch: touch(), now: at(10 * 60_000) });
    expect(plan.contactOp.kind).toBe('keep');
    if (plan.contactOp.kind === 'keep') expect(plan.contactOp.contactId).toBe('A');
    expect(plan.reopened).toBe(true);
    expect(plan.item.status).toBe('unresponded');
    expect(plan.item.notified_levels).toEqual([]); // escalation clock reset
  });

  it('auto-resolves on an outbound touch', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [1], lastMessageAt: null };
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

// ─── planIngest — new fields flow through ────────────────────────────────────

describe('planIngest — leadKind + quoteValue thread through to item row', () => {
  it('defaults lead_kind to "lead" when the touch omits leadKind', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.item.lead_kind).toBe('lead');
    expect(plan.item.quote_value).toBeNull();
  });

  it('carries leadKind "automated" and quoteValue through to the item row', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ leadKind: 'automated', quoteValue: 2218.5 }),
      now: at(HOUR),
    });
    expect(plan.item.lead_kind).toBe('automated');
    expect(plan.item.quote_value).toBe(2218.5);
  });

  it('carries leadKind "lead" and a null quoteValue explicitly set', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ leadKind: 'lead', quoteValue: null }),
      now: at(HOUR),
    });
    expect(plan.item.lead_kind).toBe('lead');
    expect(plan.item.quote_value).toBeNull();
  });
});

// ─── listOpenItems — I/O layer (mocked Supabase) ─────────────────────────────
//
// listOpenItems makes TWO sequential calls to sb.from('inbox_items'):
//   1. The main select (with .eq/.order/.limit)
//   2. The returning-proxy count (.in('contact_id', [...]).select('contact_id'))
//
// We mock @/lib/supabase so getSupabaseServiceClient() returns a controlled fake.
// Each call to .from('inbox_items') gets its own builder; we track call order with
// a counter so we can return different data per call.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => null,
}));

import { listOpenItems, listEscalatableItems } from './store';

/** Build a Supabase chain stub where the terminal await returns `result`.
 *  All intermediate chaining methods (select, eq, order, limit, in, or, is) return
 *  `self` so callers can chain freely. The spy arrays let us assert on what was called. */
function makeBuilder(result: { data: unknown; error: null | { message: string } }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'or', 'is']) {
    self[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return self;
    };
  }
  // Terminal await — vitest resolves a thenable.
  self.then = (resolve: (v: unknown) => void) => resolve(result);
  return { builder: self, calls };
}

describe('listOpenItems — select string, sort order, and field mapping', () => {
  beforeEach(() => {
    // Reset between tests.
    sbRef.current = null;
  });

  it('includes lead_kind and quote_value in the select string and sorts ascending (oldest-first)', async () => {
    const { builder: mainBuilder, calls: mainCalls } = makeBuilder({ data: [], error: null });
    // Second query (returning proxy) returns empty when no contact_ids.
    // With empty data the second from() is never called; this branch is fine.
    sbRef.current = {
      from: (_table: string) => mainBuilder,
    };

    const result = await listOpenItems(50);
    expect(result.ok).toBe(true);

    const selectCall = mainCalls.find((c) => c.method === 'select');
    expect(selectCall).toBeDefined();
    const selectStr = selectCall!.args[0] as string;
    expect(selectStr).toContain('lead_kind');
    expect(selectStr).toContain('quote_value');

    const orderCall = mainCalls.find((c) => c.method === 'order');
    expect(orderCall).toBeDefined();
    expect(orderCall!.args[1]).toEqual({ ascending: true });
  });

  it('maps lead_kind "automated" and quote_value to OpenInboxItem fields', async () => {
    const row = {
      id: 'item-1',
      source: 'ghl',
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-06-28T15:00:00Z',
      preview: 'test preview',
      subject: null,
      escalation_level: 1,
      contact_id: 'c-42',
      lead_kind: 'automated',
      quote_value: 2218.5,
      dashboard_contacts: { display_name: 'Jane', primary_email: 'j@example.com', primary_phone: null, assigned_to: null },
    };

    // First call: main list — returns one row with contact_id 'c-42'.
    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });

    // Second call: returning proxy — returns two rows for 'c-42' (so it IS returning).
    const { builder: countBuilder } = makeBuilder({
      data: [{ contact_id: 'c-42' }, { contact_id: 'c-42' }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : countBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.leadKind).toBe('automated');
    expect(item.quoteValue).toBe(2218.5);
    expect(item.isReturning).toBe(true); // two rows for the same contact_id → returning
  });

  it('maps lead_kind null (or unknown) to "lead" and isReturning false for unlinked item', async () => {
    const row = {
      id: 'item-2',
      source: 'ghl',
      channel: 'email',
      direction: 'inbound',
      last_message_at: '2026-06-28T10:00:00Z',
      preview: null,
      subject: 'Inquiry',
      escalation_level: 0,
      contact_id: null, // unlinked
      lead_kind: null,
      quote_value: null,
      dashboard_contacts: null,
    };

    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });
    // No contact_ids → second query never fires.
    sbRef.current = { from: (_table: string) => mainBuilder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.items[0];
    expect(item.leadKind).toBe('lead'); // null → default 'lead'
    expect(item.quoteValue).toBeNull();
    expect(item.isReturning).toBe(false); // no contact_id
  });

  it('filters out followed items via .is("followed_up_at", null)', async () => {
    const { builder: mainBuilder, calls: mainCalls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: (_table: string) => mainBuilder };

    const result = await listOpenItems(50);
    expect(result.ok).toBe(true);

    const isCall = mainCalls.find((c) => c.method === 'is');
    expect(isCall).toBeDefined();
    expect(isCall!.args[0]).toBe('followed_up_at');
    expect(isCall!.args[1]).toBeNull();
  });
});

// ─── planIngest — clearFollowedUp ────────────────────────────────────────────

describe('planIngest — clearFollowedUp', () => {
  it('sets clearFollowedUp=true when touch.lastMessageAt is genuinely newer than existing.lastMessageAt', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'unresponded',
      notifiedLevels: [],
      lastMessageAt: T, // base time
    };
    // touch arrives 1 hour after the existing message
    const plan = planIngest({ candidates: [], existing, touch: touch({ lastMessageAt: at(HOUR) }), now: at(2 * HOUR) });
    expect(plan.clearFollowedUp).toBe(true);
  });

  it('sets clearFollowedUp=false when touch.lastMessageAt equals existing.lastMessageAt (same-message re-ingest, preserves snooze)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'unresponded',
      notifiedLevels: [],
      lastMessageAt: T, // same timestamp as touch
    };
    const plan = planIngest({ candidates: [], existing, touch: touch({ lastMessageAt: T }), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(false);
  });

  it('sets clearFollowedUp=false when there is no existing item (new conversation)', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(false);
  });

  it('sets clearFollowedUp=true when existing.lastMessageAt is null (mirrors handled-reopen guard)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'handled',
      notifiedLevels: [],
      lastMessageAt: null, // null → treat touch as newer
    };
    const plan = planIngest({ candidates: [], existing, touch: touch(), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(true);
  });

  it('sets clearFollowedUp=false on our OWN newer OUTBOUND reply (a sent reply must NOT wipe the snooze)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'handled', // a sent reply marked it handled + followed
      notifiedLevels: [],
      lastMessageAt: T, // the customer's inbound
    };
    // the reconcile cron re-ingests our outbound reply, newer than the inbound —
    // direction-agnostic clearing would null followed_up_at and the item would
    // vanish from BOTH lists. The inbound gate keeps it snoozed.
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'outbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.clearFollowedUp).toBe(false);
  });
});

// ─── listEscalatableItems — escalation skips automated noise ─────────────────

describe('listEscalatableItems — .or filter excludes automated but keeps NULL', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('includes an .or call with the lead_kind filter so automated items are excluded but pre-migration NULL rows are not', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: () => builder };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);

    const orCall = calls.find((c) => c.method === 'or');
    expect(orCall).toBeDefined();
    expect(orCall!.args[0]).toBe('lead_kind.is.null,lead_kind.neq.automated');
  });

  it('excludes manually-Followed items via .is("followed_up_at", null) so a snoozed item stops escalating (#110 W7-005)', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: () => builder };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);

    const isCall = calls.find((c) => c.method === 'is');
    expect(isCall).toBeDefined();
    expect(isCall!.args[0]).toBe('followed_up_at');
    expect(isCall!.args[1]).toBeNull();
  });
});
