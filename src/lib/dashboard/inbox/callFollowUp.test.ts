import { describe, it, expect } from 'vitest';
import { followUpAnchor, callQualifies, planCallFollowUps, MIN_CALL_SECONDS, type CallRow, type AnchorInput } from './callFollowUp';

const d = (iso: string) => new Date(iso);

function call(over: Partial<CallRow> = {}): CallRow {
  return {
    direction: 'outbound',
    durationSeconds: 120,
    calledAt: d('2026-09-01T15:00:00Z'),
    isTest: false,
    ...over,
  };
}

function anchorInput(over: Partial<AnchorInput> = {}): AnchorInput {
  return {
    followedUpAt: null,
    lastInboundAt: null,
    lastMessageAt: null,
    ...over,
  };
}

describe('followUpAnchor', () => {
  it('a row nobody has followed up on anchors on when the customer last contacted us', () => {
    const anchor = followUpAnchor(
      anchorInput({ lastInboundAt: d('2026-07-16T19:14:00Z'), lastMessageAt: d('2026-07-10T00:00:00Z') }),
    );
    expect(anchor?.toISOString()).toBe('2026-07-16T19:14:00.000Z');
  });

  it('falls back to the last message when we have no inbound time', () => {
    // 30 of the 80 never-followed rows in prod carry no last_inbound_at, so
    // this fallback decides the rule for them rather than being a rare edge.
    const anchor = followUpAnchor(anchorInput({ lastInboundAt: null, lastMessageAt: d('2026-08-10T15:40:00Z') }));
    expect(anchor?.toISOString()).toBe('2026-08-10T15:40:00.000Z');
  });

  it('an already-followed row anchors on the follow-up stamp when that is later', () => {
    // The re-chase case: they went quiet again after we last marked them
    // followed, so only a call SINCE that stamp is a fresh outreach.
    const anchor = followUpAnchor(
      anchorInput({ followedUpAt: d('2026-08-20T12:00:00Z'), lastInboundAt: d('2026-07-16T19:14:00Z') }),
    );
    expect(anchor?.toISOString()).toBe('2026-08-20T12:00:00.000Z');
  });

  it('takes the customer contact when it is later than the follow-up stamp', () => {
    const anchor = followUpAnchor(
      anchorInput({ followedUpAt: d('2026-07-01T00:00:00Z'), lastInboundAt: d('2026-08-30T00:00:00Z') }),
    );
    expect(anchor?.toISOString()).toBe('2026-08-30T00:00:00.000Z');
  });

  it('is null when the row carries no usable time at all', () => {
    expect(followUpAnchor(anchorInput())).toBeNull();
  });
});

describe('callQualifies', () => {
  const anchor = d('2026-08-20T12:00:00Z');

  it('a real outbound conversation after the anchor counts', () => {
    expect(callQualifies(call(), anchor)).toBe(true);
  });

  it('an INBOUND call never counts, however long', () => {
    // Being phoned BY a customer is them chasing us. Marking that as our
    // follow-up would snooze a row for the opposite of the reason it exists.
    expect(callQualifies(call({ direction: 'inbound', durationSeconds: 600 }), anchor)).toBe(false);
  });

  it('a call under 30 seconds does not count', () => {
    // A ring-out or a straight-to-voicemail is not reaching someone. Prod:
    // any-call-counts would have cleared 55 of 80 rows, 30s+ clears 7.
    expect(callQualifies(call({ durationSeconds: 29 }), anchor)).toBe(false);
    expect(callQualifies(call({ durationSeconds: MIN_CALL_SECONDS }), anchor)).toBe(true);
  });

  it('a call with no recorded duration does not count', () => {
    expect(callQualifies(call({ durationSeconds: null }), anchor)).toBe(false);
  });

  it('a test call never counts', () => {
    expect(callQualifies(call({ isTest: true }), anchor)).toBe(false);
  });

  it('a call from BEFORE the anchor does not count', () => {
    // It was not a follow-up on this silence, so it must not clear the row.
    expect(callQualifies(call({ calledAt: d('2026-08-19T23:59:59Z') }), anchor)).toBe(false);
  });

  it('a call exactly ON the anchor does not count', () => {
    // Strictly after. This is what makes a re-run a no-op: once we stamp the
    // follow-up AT the call time, that same call stops qualifying.
    expect(callQualifies(call({ calledAt: anchor }), anchor)).toBe(false);
  });

  it('with no anchor at all, any qualifying call counts', () => {
    expect(callQualifies(call(), null)).toBe(true);
    expect(callQualifies(call({ direction: 'inbound' }), null)).toBe(false);
  });

  it('is idempotent by construction: stamping at the call time retires that call', () => {
    // Run one: the call qualifies against the old anchor.
    const before = d('2026-08-20T12:00:00Z');
    const c = call({ calledAt: d('2026-08-25T09:00:00Z') });
    expect(callQualifies(c, before)).toBe(true);
    // We stamp followed_up_at = the call time. Run two anchors on that stamp.
    const after = followUpAnchor(anchorInput({ followedUpAt: c.calledAt }));
    expect(callQualifies(c, after)).toBe(false);
  });
});

describe('planCallFollowUps', () => {
  const ITEM = {
    id: 'i1',
    ghlContactId: 'g1',
    followedUpAt: null,
    lastInboundAt: d('2026-07-16T19:14:00Z'),
    lastMessageAt: null,
  };

  it('stamps the item at the CALL time, not at now', () => {
    // Stamping at the call time is what makes a re-run a no-op, and it is also
    // the honest date: we reached out then, not when the sweep happened to run.
    const plan = planCallFollowUps({
      items: [ITEM],
      calls: [call({ calledAt: d('2026-08-25T09:00:00Z') })].map((c) => ({ ...c, ghlContactId: 'g1' })),
    });
    expect(plan).toEqual([{ itemId: 'i1', calledAt: d('2026-08-25T09:00:00Z') }]);
  });

  it('uses the LATEST qualifying call when there are several', () => {
    const plan = planCallFollowUps({
      items: [ITEM],
      calls: [
        { ...call({ calledAt: d('2026-08-21T09:00:00Z') }), ghlContactId: 'g1' },
        { ...call({ calledAt: d('2026-08-29T11:30:00Z') }), ghlContactId: 'g1' },
        { ...call({ calledAt: d('2026-08-25T09:00:00Z') }), ghlContactId: 'g1' },
      ],
    });
    expect(plan).toEqual([{ itemId: 'i1', calledAt: d('2026-08-29T11:30:00Z') }]);
  });

  it('ignores calls belonging to a different contact', () => {
    const plan = planCallFollowUps({
      items: [ITEM],
      calls: [{ ...call(), ghlContactId: 'someone-else' }],
    });
    expect(plan).toEqual([]);
  });

  it('ignores an item with no HighLevel contact id', () => {
    // 6 of the 82 awaiting rows in prod have none; they simply cannot be matched.
    const plan = planCallFollowUps({
      items: [{ ...ITEM, ghlContactId: null }],
      calls: [{ ...call(), ghlContactId: 'g1' }],
    });
    expect(plan).toEqual([]);
  });

  it('skips every call that fails the rule', () => {
    const plan = planCallFollowUps({
      items: [ITEM],
      calls: [
        { ...call({ direction: 'inbound' }), ghlContactId: 'g1' },
        { ...call({ durationSeconds: 5 }), ghlContactId: 'g1' },
        { ...call({ isTest: true }), ghlContactId: 'g1' },
        { ...call({ calledAt: d('2026-07-01T00:00:00Z') }), ghlContactId: 'g1' },
      ],
    });
    expect(plan).toEqual([]);
  });

  it('re-chases an already-followed row only with a call SINCE that stamp', () => {
    // The rows in Naldo's screenshot: already followed, gone quiet again.
    const followed = { ...ITEM, followedUpAt: d('2026-08-20T12:00:00Z') };
    const stale = planCallFollowUps({
      items: [followed],
      calls: [{ ...call({ calledAt: d('2026-08-19T09:00:00Z') }), ghlContactId: 'g1' }],
    });
    expect(stale).toEqual([]);

    const fresh = planCallFollowUps({
      items: [followed],
      calls: [{ ...call({ calledAt: d('2026-08-28T09:00:00Z') }), ghlContactId: 'g1' }],
    });
    expect(fresh).toEqual([{ itemId: 'i1', calledAt: d('2026-08-28T09:00:00Z') }]);
  });

  it('running it twice changes nothing the second time', () => {
    // The whole backfill safety story. Apply run one, feed the result back in
    // as the row's new state, and run two must be empty.
    const calls = [{ ...call({ calledAt: d('2026-08-28T09:00:00Z') }), ghlContactId: 'g1' }];
    const first = planCallFollowUps({ items: [ITEM], calls });
    expect(first).toHaveLength(1);

    const afterWrite = { ...ITEM, followedUpAt: first[0].calledAt };
    const second = planCallFollowUps({ items: [afterWrite], calls });
    expect(second).toEqual([]);
  });

  it('a customer reply AFTER our call re-opens the row rather than leaving it snoozed', () => {
    // They wrote back since we phoned, so the call is no longer the latest word
    // and must not stamp the row followed again.
    const repliedSince = {
      ...ITEM,
      followedUpAt: d('2026-08-20T12:00:00Z'),
      lastInboundAt: d('2026-08-30T08:00:00Z'),
    };
    const plan = planCallFollowUps({
      items: [repliedSince],
      calls: [{ ...call({ calledAt: d('2026-08-28T09:00:00Z') }), ghlContactId: 'g1' }],
    });
    expect(plan).toEqual([]);
  });

  it('handles many items and many calls without cross-contamination', () => {
    const plan = planCallFollowUps({
      items: [
        { ...ITEM, id: 'a', ghlContactId: 'g1' },
        { ...ITEM, id: 'b', ghlContactId: 'g2' },
        { ...ITEM, id: 'c', ghlContactId: 'g3' },
      ],
      calls: [
        { ...call({ calledAt: d('2026-08-25T09:00:00Z') }), ghlContactId: 'g1' },
        { ...call({ calledAt: d('2026-08-26T09:00:00Z') }), ghlContactId: 'g3' },
      ],
    });
    expect(plan).toEqual([
      { itemId: 'a', calledAt: d('2026-08-25T09:00:00Z') },
      { itemId: 'c', calledAt: d('2026-08-26T09:00:00Z') },
    ]);
  });
});
