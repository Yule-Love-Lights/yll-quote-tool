// What this browser opened from the search box, most recent first.
//
// Naldo, 2026-09-01: the box shows nothing until you type, and the commonest
// real action is going back to the customer you were just looking at.
//
// SESSION storage, not local (deliberate). These entries hold customer NAMES
// and record numbers, and the office shares computers. sessionStorage dies
// with the browser tab, so the list survives the afternoon's work and does not
// outlive the browser. The same session that added this removed a stored ROLE
// for that reason; storing customer detail more permanently than a role would
// be backwards.
//
// That is not sufficient on its own, which the premerge staff lens caught: a
// tab left open across a shift change keeps its session storage, so signing
// out CLEARS this list (clearRecent, called from the nav's sign-out path).
// Without that, the next person to sign in on the same tab is greeted by the
// last person's customers.
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

/**
 * Whether a stored href is an in-app path. PURE.
 *
 * Hand-rolled prefix checks are not enough here and this function exists
 * because one was not: the first version blocked "//evil.example.com" and let
 * "/\evil.example.com" through, which the URL parser reads as exactly the same
 * protocol-relative authority and the Next router follows off-site. Found by
 * the premerge technical lens, which traced it through the installed router
 * rather than reasoning about it.
 *
 * So the check is no longer a guess about which prefixes are dangerous: the
 * value is resolved against a throwaway origin and must still be ON that
 * origin. Whatever the parser thinks the string means, that is what gets
 * judged.
 */
export function isInAppPath(href: string): boolean {
  if (typeof href !== 'string' || !href.startsWith('/')) return false;
  // Control characters are stripped by the parser before it decides what the
  // string means, so reject them outright rather than letting them smuggle a
  // shape past the origin check.
  for (let i = 0; i < href.length; i += 1) {
    const code = href.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const base = 'https://in-app.invalid';
  try {
    return new URL(href, base).origin === base;
  } catch {
    return false;
  }
}

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
      isInAppPath(href) &&
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

/**
 * Forget everything. Called when someone signs out, so a shared computer with
 * the tab left open does not hand the next person the last one's customers.
 */
export function clearRecent(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same reasoning as writeRecent: nothing here is worth interrupting a
    // sign-out over. The list dies with the tab regardless.
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
