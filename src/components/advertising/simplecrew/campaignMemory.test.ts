// The camera's campaign memory (Naldo, 2026-08-29): a worker canvassing all
// afternoon should not re-pick the same campaign on every visit, but a
// stale campaign must never catch a photo silently. These tests pin the
// decision itself, independent of the camera UI.

import { describe, expect, it } from 'vitest';
import { decideCampaign, MEMORY_FRESH_MS, type RememberedCampaign } from './campaignMemory';

const CAMPAIGNS = [
  { id: 'c1', name: 'Fall Signs' },
  { id: 'c2', name: 'Door Hangers' },
];
const NOW = 1_700_000_000_000;
const remembered = (over: Partial<RememberedCampaign> = {}): RememberedCampaign => ({
  campaignId: 'c1',
  at: NOW - 60_000,
  ...over,
});

describe('decideCampaign', () => {
  it('a campaign named by the page wins outright, with no confirm: the page the worker came from said which one', () => {
    const d = decideCampaign({ fromPageCampaignId: 'c2', remembered: remembered(), campaigns: CAMPAIGNS, now: NOW });
    expect(d).toEqual({ campaignId: 'c2', needsConfirm: false });
  });

  it('the page wins even when nothing is remembered', () => {
    const d = decideCampaign({ fromPageCampaignId: 'c2', remembered: null, campaigns: CAMPAIGNS, now: NOW });
    expect(d).toEqual({ campaignId: 'c2', needsConfirm: false });
  });

  it('a recent memory is used silently', () => {
    const d = decideCampaign({ fromPageCampaignId: null, remembered: remembered(), campaigns: CAMPAIGNS, now: NOW });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: false });
  });

  it('at the boundary the memory is already stale, so it asks', () => {
    const d = decideCampaign({
      fromPageCampaignId: null,
      remembered: remembered({ at: NOW - MEMORY_FRESH_MS }),
      campaigns: CAMPAIGNS,
      now: NOW,
    });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: true });
  });

  it('an old memory preselects but must be confirmed before the shutter works', () => {
    const d = decideCampaign({
      fromPageCampaignId: null,
      remembered: remembered({ at: NOW - MEMORY_FRESH_MS * 30 }),
      campaigns: CAMPAIGNS,
      now: NOW,
    });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: true });
  });

  it('no memory at all means no campaign and the existing empty state', () => {
    const d = decideCampaign({ fromPageCampaignId: null, remembered: null, campaigns: CAMPAIGNS, now: NOW });
    expect(d).toEqual({ campaignId: null, needsConfirm: false });
  });

  it('a remembered campaign that is gone, inactive, or not this worker\u2019s falls back to picking', () => {
    const d = decideCampaign({
      fromPageCampaignId: null,
      remembered: remembered({ campaignId: 'deleted' }),
      campaigns: CAMPAIGNS,
      now: NOW,
    });
    expect(d).toEqual({ campaignId: null, needsConfirm: false });
  });

  it('a page campaign that is not in the list is ignored rather than trusted', () => {
    const d = decideCampaign({ fromPageCampaignId: 'ghost', remembered: remembered(), campaigns: CAMPAIGNS, now: NOW });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: false });
  });

  it('a memory with a junk timestamp is treated as stale, never as fresh', () => {
    const d = decideCampaign({
      fromPageCampaignId: null,
      remembered: remembered({ at: Number.NaN }),
      campaigns: CAMPAIGNS,
      now: NOW,
    });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: true });
  });

  it('a future timestamp (clock skew) is treated as stale, never as fresh', () => {
    const d = decideCampaign({
      fromPageCampaignId: null,
      remembered: remembered({ at: NOW + MEMORY_FRESH_MS * 5 }),
      campaigns: CAMPAIGNS,
      now: NOW,
    });
    expect(d).toEqual({ campaignId: 'c1', needsConfirm: true });
  });

  it('the list arriving empty (a failed load) never invents a campaign', () => {
    const d = decideCampaign({ fromPageCampaignId: 'c1', remembered: remembered(), campaigns: [], now: NOW });
    expect(d).toEqual({ campaignId: null, needsConfirm: false });
  });
});

// The camera's own wiring is pinned by the decision above plus this
// invariant: whenever the decision says confirm, there IS a campaign to
// name in the bar, so the worker is never asked to confirm nothing.
describe('the confirm state always has something to name', () => {
  it('needsConfirm is never true without a campaign', () => {
    const cases = [
      { fromPageCampaignId: null, remembered: null },
      { fromPageCampaignId: null, remembered: { campaignId: 'gone', at: NOW - MEMORY_FRESH_MS * 5 } },
      { fromPageCampaignId: 'ghost', remembered: null },
    ];
    for (const c of cases) {
      const d = decideCampaign({ ...c, campaigns: CAMPAIGNS, now: NOW });
      if (d.needsConfirm) expect(d.campaignId).not.toBeNull();
    }
  });
});
