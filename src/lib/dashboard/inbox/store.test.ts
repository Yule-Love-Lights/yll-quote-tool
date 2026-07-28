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

// ─── planIngest — noopReingest (#110 W7-004 write-amplification) ──────────────

describe('planIngest — noopReingest short-circuits dead re-ingests', () => {
  const resolved = (status: 'handled' | 'completed' | 'dismissed'): ExistingItem => ({
    id: 'i1',
    contactId: 'A',
    status,
    notifiedLevels: [],
    lastMessageAt: T,
  });

  it('re-ingesting our own outbound on an already-handled item (same last_message_at) is a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('handled'),
      touch: touch({ direction: 'outbound', lastMessageAt: T }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(true);
    expect(plan.autoResolved).toBe(false);
  });

  it('re-ingesting a completed item with the same message is a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('completed'),
      touch: touch({ direction: 'outbound', lastMessageAt: T }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(true);
  });

  it('a genuinely-new inbound that REOPENS a handled item is NOT a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('handled'),
      touch: touch({ direction: 'inbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.reopened).toBe(true);
    expect(plan.noopReingest).toBe(false);
  });

  it('the FIRST outbound that auto-resolves an unresponded item is NOT a no-op', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'outbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.autoResolved).toBe(true);
    expect(plan.noopReingest).toBe(false);
  });

  it('an unresponded item re-ingested with the same message is NOT a no-op (escalation colour ages)', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'inbound', lastMessageAt: T }),
      now: at(5 * HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  it('a brand-new conversation (no existing item) is NOT a no-op', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.noopReingest).toBe(false);
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

import {
  ensureFollowUp,
  EXCLUDE_LEGACY_REBOOK_FROM_INBOX,
  excludeLegacyRebookItems,
  listOpenItems,
  listEscalatableItems,
  markFollowUpDone,
} from './store';

/** Build a Supabase chain stub where the terminal await returns `result`.
 *  All intermediate chaining methods (select, eq, order, limit, in, or, is) return
 *  `self` so callers can chain freely. The spy arrays let us assert on what was called. */
function makeBuilder(result: { data: unknown; error: null | { message: string }; count?: number | null }) {
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

// ─── excludeLegacyRebookItems — #157 (pure) ──────────────────────────────────

describe('excludeLegacyRebookItems (#157 — YLL Neighbors inbox exclusion)', () => {
  it('the reversible seam defaults ON (excluding legacy-rebook items from the inbox)', () => {
    expect(EXCLUDE_LEGACY_REBOOK_FROM_INBOX).toBe(true);
  });

  it('drops a quotetool item whose external_id is a legacy_rebook quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-legacy' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toHaveLength(0);
  });

  it('keeps a quotetool item whose external_id is NOT a legacy_rebook quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-normal' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toEqual(items);
  });

  it('never touches a non-quotetool item, even if its external_id collides with a legacy quote id', () => {
    const items = [
      { source: 'ghl', external_id: 'quote-legacy' },
      { source: 'gmail', external_id: 'quote-legacy' },
      { source: 'homeworks', external_id: 'quote-legacy' },
    ];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toEqual(items);
  });

  it('passes every item through unchanged when legacyQuoteIds is empty', () => {
    const items = [
      { source: 'quotetool', external_id: 'q1' },
      { source: 'ghl', external_id: 'msg-1' },
    ];
    const result = excludeLegacyRebookItems(items, new Set());
    expect(result).toEqual(items);
  });

  it('filters a mixed batch: legacy quotetool dropped, normal quotetool + other sources kept', () => {
    const items = [
      { source: 'quotetool', external_id: 'quote-legacy' },
      { source: 'quotetool', external_id: 'quote-normal' },
      { source: 'ghl', external_id: 'ghl-msg-1' },
    ];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result.map((i) => i.external_id)).toEqual(['quote-normal', 'ghl-msg-1']);
  });
});

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

// ─── listOpenItems — truncation signal (WT-41) ───────────────────────────────
//
// Above the page cap, listOpenItems returns only the oldest `limit` items (by
// design — they're the longest-waiting), but the "Open leads" count must not
// silently under-report. `totalOpen` comes from Postgrest's exact count (via
// { count: 'exact' } on .select()), which is NOT affected by .limit().

describe('listOpenItems — truncation signal (WT-41)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('passes { count: "exact" } as select options so Postgrest returns the untruncated total', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null, count: 0 });
    sbRef.current = { from: (_table: string) => builder };

    await listOpenItems(50);

    const selectCall = calls.find((c) => c.method === 'select');
    expect(selectCall).toBeDefined();
    expect(selectCall!.args[1]).toEqual({ count: 'exact' });
  });

  it('reports truncated=true and the real total when the fetched page is smaller than the total open count', async () => {
    const row = (id: string) => ({
      id,
      source: 'ghl',
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-06-28T10:00:00Z',
      preview: null,
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: null,
      quote_value: null,
      dashboard_contacts: null,
    });
    const { builder } = makeBuilder({ data: [row('a'), row('b')], error: null, count: 150 });
    sbRef.current = { from: (_table: string) => builder };

    const result = await listOpenItems(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(2);
    expect(result.totalOpen).toBe(150);
    expect(result.truncated).toBe(true); // 148 more open items not shown
  });

  it('reports truncated=false when the fetched page covers every open item', async () => {
    const { builder } = makeBuilder({ data: [], error: null, count: 0 });
    sbRef.current = { from: (_table: string) => builder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totalOpen).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ─── listOpenItems — legacy-rebook exclusion wiring (#157) ──────────────────
//
// listOpenItems makes a THIRD sb.from('quotes') call ONLY when the fetched page
// contains 'quotetool' items — proving the STORE (not just the pure function)
// actually excludes legacy-rebook drafts, and that every consumer (inbox page,
// nav badge via buildInboxSummary, /api/inbox) inherits it automatically since
// they all read through this one function.

describe('listOpenItems — legacy-rebook exclusion wiring (#157)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const row = (id: string, source: string, externalId: string) => ({
    id,
    source,
    external_id: externalId,
    channel: 'app',
    direction: 'inbound',
    last_message_at: '2026-07-16T10:00:00Z',
    preview: null,
    subject: null,
    escalation_level: 0,
    contact_id: null,
    lead_kind: null,
    quote_value: null,
    dashboard_contacts: null,
  });

  it('excludes a quotetool item whose quote is legacy_rebook=true, keeps normal quotetool + other sources', async () => {
    const rows = [
      row('i-legacy', 'quotetool', 'quote-legacy'),
      row('i-normal', 'quotetool', 'quote-normal'),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 3 });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: 'quote-legacy', legacy_rebook: true },
        { id: 'quote-normal', legacy_rebook: false },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((i) => i.id)).toEqual(['i-normal', 'i-ghl']);
    expect(result.totalOpen).toBe(2); // 3 total − 1 excluded legacy item
    expect(result.truncated).toBe(false);

    // The quotes lookup only queried the ids seen on THIS page (the quotetool
    // ones) — never the ghl item's external_id.
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall).toBeDefined();
    expect(inCall!.args[1]).toEqual(expect.arrayContaining(['quote-legacy', 'quote-normal']));
    expect(inCall!.args[1]).toHaveLength(2);
  });

  it('skips the quotes lookup entirely when the page has no quotetool items', async () => {
    const rows = [row('i-ghl', 'ghl', 'ghl-msg-1')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 1 });

    let fromCalls = 0;
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return mainBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(1);
    // No contact_id → no returning-proxy call; no quotetool ids → no quotes call.
    expect(fromCalls).toBe(1);
  });
});

// ─── ensureFollowUp — idempotency scoped to pending only (WT-43) ────────────
//
// A quotetool item's id is stable, so the OLD "any status" idempotency check
// meant clicking Done once permanently killed the "sent, no reply" nudge for
// that (item, reason) forever — the reconcile cron never recreated it, even
// weeks later while the quote was still unapproved. Scoping the check to
// status='pending' lets a fresh nudge fire after a prior one was closed.

describe('ensureFollowUp — idempotency scoped to pending (WT-43)', () => {
  type FollowUpRow = {
    id: string;
    inbox_item_id: string;
    reason: string;
    status: string;
    [key: string]: unknown;
  };

  /** Minimal stateful fake for the follow_ups table: supports the
   *  select().eq().eq().eq().limit() idempotency check, the plain insert()
   *  ensureFollowUp issues, and the update().eq('id', ...) markFollowUpDone
   *  issues — enough to exercise the real create → done → recreate lifecycle. */
  function makeFollowUpsFake(seed: FollowUpRow[]) {
    const rows: FollowUpRow[] = seed.map((r) => ({ ...r }));
    let nextId = rows.length + 1;
    function table() {
      const filters: Record<string, unknown> = {};
      let mode: 'select' | 'insert' | 'update' | 'upsert' | null = null;
      let insertRow: Record<string, unknown> | undefined;
      let updateFields: Record<string, unknown> | undefined;
      let upsertConflict: string | undefined;
      const self: Record<string, unknown> = {};
      self.select = () => {
        mode = 'select';
        return self;
      };
      self.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return self;
      };
      self.limit = () => self;
      self.insert = (row: Record<string, unknown>) => {
        mode = 'insert';
        insertRow = row;
        return self;
      };
      self.update = (fields: Record<string, unknown>) => {
        mode = 'update';
        updateFields = fields;
        return self;
      };
      // Models Postgres UPSERT against the real `unique (inbox_item_id, reason)`
      // constraint: a conflicting row is UPDATED in place, never duplicated.
      self.upsert = (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
        mode = 'upsert';
        insertRow = row;
        upsertConflict = opts?.onConflict;
        return self;
      };
      self.then = (resolve: (v: unknown) => void) => {
        if (mode === 'insert') {
          const row = { id: String(nextId++), ...insertRow } as FollowUpRow;
          rows.push(row);
          resolve({ data: [row], error: null });
        } else if (mode === 'update') {
          for (const r of rows) {
            if (Object.entries(filters).every(([k, v]) => r[k] === v)) Object.assign(r, updateFields);
          }
          resolve({ data: null, error: null });
        } else if (mode === 'upsert') {
          const cols = (upsertConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
          const existing = cols.length
            ? rows.find((r) => cols.every((c) => r[c] === (insertRow as Record<string, unknown>)[c]))
            : undefined;
          if (existing) {
            Object.assign(existing, insertRow); // re-arm: done -> pending, fresh due_at
            resolve({ data: [existing], error: null });
          } else {
            const row = { id: String(nextId++), ...insertRow } as FollowUpRow;
            rows.push(row);
            resolve({ data: [row], error: null });
          }
        } else {
          const matched = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          resolve({ data: matched, error: null });
        }
      };
      return self;
    }
    return { rows, table };
  }

  /** Swallows any non-follow_ups table (dashboard_activity) with a no-op stub. */
  function genericTable() {
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.eq = () => self;
    self.insert = () => self;
    self.update = () => self;
    self.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    return self;
  }

  beforeEach(() => {
    sbRef.current = null;
  });

  it('does not duplicate while a PENDING follow-up for the same (item, reason) exists', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

    expect(fake.rows).toHaveLength(1); // no new insert — the pending row already covers it
  });

  it('re-arms the follow-up (done -> pending) after a prior one for the same (item, reason) was marked done', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    // Operator (or an auto-close) marks the existing follow-up done...
    const done = await markFollowUpDone('fu-1', 'operator-1');
    expect(done.ok).toBe(true);
    expect(fake.rows[0].status).toBe('done');

    // ...weeks later, a second "quote sent, no reply" cycle fires for the SAME
    // still-unapproved item. WT-43: the real `unique (inbox_item_id, reason)`
    // constraint means a plain insert would 23505 + silently no-op, so ensureFollowUp
    // must UPSERT the existing row back to pending (never a duplicate).
    await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

    // Still exactly ONE row (the unique constraint forbids a duplicate), flipped
    // back to pending so the nudge re-arms.
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].status).toBe('pending');
    expect(fake.rows[0].inbox_item_id).toBe('item-1');
    expect(fake.rows[0].reason).toBe('quote_sent_no_reply');
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

// ─── listEscalatableItems — legacy-rebook exclusion wiring (#181 / #157) ────
//
// Same #157 exclusion listOpenItems already applies to the /inbox display,
// extended (#181) to escalation: a YLL Neighbor item must never trip an
// amber/red alert or land in the EOD digest either. Mirrors the listOpenItems
// legacy-rebook wiring tests above.

describe('listEscalatableItems — legacy-rebook exclusion wiring (#181)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const row = (id: string, source: string, externalId: string) => ({
    id,
    source,
    external_id: externalId,
    last_message_at: '2026-07-16T10:00:00Z',
    notified_levels: [],
    escalation_level: 0,
    preview: null,
    dashboard_contacts: null,
  });

  it('excludes a quotetool item whose quote is legacy_rebook=true, keeps normal quotetool + other sources', async () => {
    const rows = [
      row('i-legacy', 'quotetool', 'quote-legacy'),
      row('i-normal', 'quotetool', 'quote-normal'),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: 'quote-legacy', legacy_rebook: true },
        { id: 'quote-normal', legacy_rebook: false },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((i) => i.id)).toEqual(['i-normal', 'i-ghl']);

    // Same predicate call shape as listOpenItems: batch-fetch only the
    // quotetool ids seen on this read.
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall).toBeDefined();
    expect(inCall!.args[1]).toEqual(expect.arrayContaining(['quote-legacy', 'quote-normal']));
    expect(inCall!.args[1]).toHaveLength(2);
  });

  it('a SENT legacy_rebook quote is excluded here too — broader than the quotetool.ts ingest-time guard (#181), matching #157 display behavior rather than fighting it', async () => {
    const rows = [row('i-sent-legacy', 'quotetool', 'quote-sent-legacy')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: 'quote-sent-legacy', legacy_rebook: true }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
  });

  it('skips the quotes lookup entirely when the page has no quotetool items', async () => {
    const rows = [row('i-ghl', 'ghl', 'ghl-msg-1')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });

    let fromCalls = 0;
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return mainBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(1);
    expect(fromCalls).toBe(1);
  });
});
