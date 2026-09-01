// What this browser opened from the search box, most recent first.
//
// Naldo, 2026-09-01: the box shows nothing until you type, and the commonest
// real action is going back to the customer you were just looking at.
//
// SESSION storage, not local (deliberate). These entries hold customer names,
// addresses and money figures, and the office shares computers. sessionStorage
// dies with the browser tab, so the list survives the afternoon's work and
// never greets the next person with a record of who the last one was looking
// at. The same session that added this removed a stored ROLE for that reason;
// storing customer detail more permanently than a role would be backwards.
//
// Everything except read/write is pure and tested directly.

import type { SearchHit } from './globalSearch';

/** Enough to cover "the one I was just on" without becoming a second list. */
export const MAX_RECENT = 5;

const STORAGE_KEY = 'yll-op-recent-hits';

/**
 * The fields worth keeping. Deliberately NOT the whole hit: `active` and
 * `status` go stale the moment the record changes, and showing a stale status
 * is worse than showing none. What is left is stable identity.
 */
export type RecentHit = Pick<SearchHit, 'kind' | 'key' | 'href' | 'title' | 'label'>;

export function toRecent(hit: SearchHit): RecentHit {
  return { kind: hit.kind, key: hit.key, href: hit.href, title: hit.title, label: hit.label };
}

/**
 * The new list after opening `hit`: it goes to the front, any earlier copy of
 * the same record is removed rather than duplicated, and the list is capped.
 * PURE, and never mutates the input.
 */
export function pushRecent(list: RecentHit[], hit: RecentHit, max = MAX_RECENT): RecentHit[] {
  return [hit, ...list.filter((h) => h.key !== hit.key)].slice(0, max);
}

/**
 * Narrow whatever came out of storage. Anything unrecognised is dropped rather
 * than rendered: this value can be hand-edited in devtools, and a row with a
 * missing href would be a link to nowhere.
 */
export function parseRecent(raw: unknown): RecentHit[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const { kind, key, href, title, label } = r;
    if (
      (kind === 'customer' || kind === 'quote' || kind === 'job' || kind === 'invoice') &&
      typeof key === 'string' &&
      typeof href === 'string' &&
      // Only in-app paths. A stored "https://..." would turn this list into an
      // off-site redirect anyone with devtools could plant.
      href.startsWith('/') &&
      !href.startsWith('//') &&
      typeof title === 'string' &&
      (label === null || typeof label === 'string')
    ) {
      out.push({ kind, key, href, title, label: (label as string | null) ?? null });
    }
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/**
 * Read the list. Returns [] on anything unexpected, including a browser that
 * refuses storage outright (private windows, blocked site data), which throws
 * on ACCESS rather than returning null.
 */
export function readRecent(): RecentHit[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return parseRecent(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Write the list. Silent on failure: a lost convenience is not worth an error. */
export function writeRecent(list: RecentHit[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // Storage full, disabled, or refused. Nothing here is worth interrupting
    // someone's work over.
  }
}
