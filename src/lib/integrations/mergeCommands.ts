/**
 * Merge-by-text command parsing for the Telegram bot.
 *
 * ⚠️ THIS COMMAND PUTS CODE ON THE LIVE SITE, so it is parsed deterministically
 * and never goes through the LLM tool dispatch. The same reasoning the crew
 * time-clock uses applies with more force here: "the model read it that way" is
 * not an acceptable explanation for a production deploy. This module either
 * recognises the command exactly or it does not act.
 *
 * The vocabulary claimed here is `merge` followed by a pull request number.
 * Checked before it was added: no other matcher in the bot claims that word
 * (the S58 lesson, where a new parser silently took over the existing bot's
 * help words for every user in every chat).
 *
 * Deliberately NOT accepted: a bare `merge` with no number, `merge all`, or
 * anything naming a branch. A merge request has to name exactly one pull
 * request, so an ambiguous text falls through to a coaching reply rather than
 * guessing at something irreversible.
 */

export type MergeCommand = { kind: 'merge'; prNumber: number };

/** Normalize: lowercase, collapse whitespace, drop a leading slash. */
function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^\/+/, '');
}

// merge 1043 · merge #1043 · merge pr 1043 · merge pr #1043
// The number is bounded to 1-6 digits: real pull request numbers are far below
// that, and an unbounded match would happily read a phone number as a merge.
const MERGE_RE = /^merge(?: pr)? #?(\d{1,6})$/;

// A short message that is clearly a merge ATTEMPT but names no usable number:
// "merge", "merge pr", "merge all", "merge 0". Deliberately narrow, mirroring
// isDepartMissingReason in crewTimeCommands.ts, which anchors the whole string
// rather than matching a prefix. A broad `^merge\b.*` would treat ordinary
// sentences like "merge conflict again on that branch" as a merge attempt and
// answer them, which is how a coaching reply turns into chatter.
const MERGE_SHAPED_RE = /^merge(?: pr)?(?: \S{1,12})?$/;

/**
 * Parse a merge request. Returns null for anything else, so ordinary bot
 * traffic (including the word "merge" used mid-sentence) is untouched.
 */
export function parseMergeCommand(text: string): MergeCommand | null {
  const match = norm(text).match(MERGE_RE);
  if (!match) return null;
  const prNumber = Number(match[1]);
  // A leading-zero form like "merge 007" resolves to 7; "merge 0" is not a
  // pull request number and is refused.
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return { kind: 'merge', prNumber };
}

/**
 * True when the text looks like a merge attempt this parser deliberately
 * refuses (a bare "merge", "merge all", "merge 0"). Used to coach the sender
 * rather than let the LLM layer improvise a reply about deploying code.
 */
export function isIncompleteMergeRequest(text: string): boolean {
  const n = norm(text);
  if (parseMergeCommand(n)) return false;
  return MERGE_SHAPED_RE.test(n);
}
