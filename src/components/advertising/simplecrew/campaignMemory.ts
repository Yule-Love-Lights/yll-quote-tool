// The camera's campaign memory (Naldo, 2026-08-29). A worker placing signs
// all afternoon re-picked the same campaign on every visit to the camera,
// and even opening the camera from inside a campaign still asked which one.
//
// The rule, and why each half exists:
//   * a campaign named by the PAGE wins outright and needs no confirming,
//     because the screen the worker came from already said which campaign;
//   * a memory from the last hour is used silently, which is the case this
//     exists for;
//   * an older memory still preselects, but the shutter stays blocked until
//     the worker confirms the name. The campaign decides what a photo is
//     worth, so yesterday's campaign must never catch today's photos just
//     because nobody looked at the top bar.
//
// Anything unusable (no memory, a campaign that has since gone or is not in
// this worker's list, a junk or future timestamp) degrades to the existing
// pick-a-campaign flow rather than to a guess.

/** How long a remembered campaign is trusted without asking. */
export const MEMORY_FRESH_MS = 60 * 60 * 1000;

export type RememberedCampaign = { campaignId: string; at: number };

export type CampaignDecision = {
  campaignId: string | null;
  /** True when the camera must have the worker confirm before shooting. */
  needsConfirm: boolean;
};

/** PURE. Which campaign the camera opens on, and whether it has to ask. */
export function decideCampaign(input: {
  /** A campaign the worker navigated in from, if any. */
  fromPageCampaignId: string | null;
  remembered: RememberedCampaign | null;
  /** The campaigns this worker can actually submit to. */
  campaigns: { id: string }[];
  now: number;
}): CampaignDecision {
  const known = (id: string | null | undefined): boolean =>
    typeof id === 'string' && id !== '' && input.campaigns.some((c) => c.id === id);

  if (known(input.fromPageCampaignId)) {
    return { campaignId: input.fromPageCampaignId, needsConfirm: false };
  }

  const remembered = input.remembered;
  if (!remembered || !known(remembered.campaignId)) {
    return { campaignId: null, needsConfirm: false };
  }

  // Only a real, non-future timestamp inside the window earns silence. A
  // NaN or a clock-skewed future stamp is treated as stale, never fresh.
  const age = input.now - remembered.at;
  const fresh = Number.isFinite(age) && age >= 0 && age < MEMORY_FRESH_MS;
  return { campaignId: remembered.campaignId, needsConfirm: !fresh };
}

const STORAGE_PREFIX = 'yll.advertising.lastCampaign';

/** Per-device, and scoped so two accounts on one phone cannot inherit each
 * other's campaign. Browser storage throws in private mode, so every access
 * is guarded and a failure simply means no memory. */
function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}.${scope}`;
}

export function readRememberedCampaign(scope: string): RememberedCampaign | null {
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedCampaign> | null;
    if (!parsed || typeof parsed.campaignId !== 'string' || typeof parsed.at !== 'number') return null;
    return { campaignId: parsed.campaignId, at: parsed.at };
  } catch {
    return null;
  }
}

export function rememberCampaign(scope: string, campaignId: string, at: number): void {
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify({ campaignId, at }));
  } catch {
    /* private mode or a full quota: the camera just keeps asking */
  }
}
