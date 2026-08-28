/**
 * Merge-by-text: lets the owner approve a reviewed pull request from Telegram.
 *
 * WHAT THIS DOES AND DOES NOT DO. This module does NOT merge anything. It
 * recognises the request, proves the sender is the one person allowed to make
 * it, and hands the pull request number to a Claude Code cloud routine that
 * re-checks the review, the CI result, and the branch before merging. The quote
 * tool therefore never holds a GitHub credential, and the review gate cannot be
 * skipped by texting.
 *
 * IDENTITY COMES FROM THE SENDER, NEVER THE MESSAGE. The approver is matched on
 * `MERGE_APPROVER_TELEGRAM_USER_ID` against Telegram's own sender id, which the
 * sender cannot choose. Being in an allowed chat is not enough, and neither is
 * an operator or admin bot role: this one action is scoped to a single person
 * because its blast radius is a production deploy.
 *
 * Fails closed everywhere. Missing configuration, a wrong sender, or a failed
 * hand-off all end in a plain refusal and an audit row, never in a merge.
 */

import { logBotAction } from './botAudit';
import { parseMergeCommand, isIncompleteMergeRequest } from './mergeCommands';

export type MergeRequestOutcome = { handled: false } | { handled: true; reply: string };

/** How long to wait on the routine hand-off before giving up (webhooks must answer fast). */
const FIRE_TIMEOUT_MS = 8000;

const NOT_CONFIGURED =
  'Merge by text is not set up yet. Merge from the Claude app instead.';
const NOT_ALLOWED = 'Only the owner can merge from here.';
const NEEDS_A_NUMBER =
  'Which pull request? Text the number, like: merge 1043. The number is in your morning report.';

function approverId(): string | null {
  const raw = process.env.MERGE_APPROVER_TELEGRAM_USER_ID?.trim();
  return raw ? raw : null;
}

function fireConfig(): { url: string; token: string } | null {
  const url = process.env.MERGE_ROUTINE_FIRE_URL?.trim();
  const token = process.env.MERGE_ROUTINE_FIRE_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Hand one pull request number to the merge routine. Returns true only on a
 * 2xx: anything else (including a network failure) is reported to the sender as
 * a failure, because silence here would read as "it worked".
 */
async function fireMergeRoutine(prNumber: number): Promise<{ ok: boolean; detail: string }> {
  const config = fireConfig();
  if (!config) return { ok: false, detail: 'not configured' };
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // The routine treats this as untrusted data and re-derives everything it
      // needs, so the payload carries the number and nothing that could read as
      // an instruction.
      body: JSON.stringify({ text: `Merge pull request ${prNumber}.` }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `fire returned ${res.status}` };
    return { ok: true, detail: 'fired' };
  } catch (err) {
    // Never surface the URL or the token in a reply or a log line: the URL
    // identifies the routine and the token is a bearer credential.
    const reason = err instanceof Error ? err.name : 'unknown error';
    return { ok: false, detail: `fire failed (${reason})` };
  }
}

/**
 * Handle a message if it is a merge request.
 *
 * Returns `{ handled: false }` for anything else, so normal bot dispatch
 * continues untouched. Mirrors the crew time-clock's placement: this runs
 * BEFORE the LLM tool layer so a production merge never depends on a model's
 * interpretation of a sentence.
 */
export async function handleMergeRequest(
  telegramUserId: string,
  text: string,
  opts: { chatId?: string | null; addressed?: boolean } = {},
): Promise<MergeRequestOutcome> {
  const command = parseMergeCommand(text);
  const addressed = opts.addressed ?? true;
  const chatId = opts.chatId ?? null;
  const approver = approverId();
  const isApprover = !!approver && telegramUserId === approver;

  if (!command) {
    // A merge-shaped message with no usable number. Coach the approver; stay out
    // of everyone else's way, since "merge" is an ordinary English word and a
    // crew group should not get deploy talk. The `addressed` check keeps the
    // bot's group contract: in a group it speaks only when spoken to, so a
    // half-typed "merge" there stays silent even for the approver.
    if (isApprover && addressed && isIncompleteMergeRequest(text)) {
      return { handled: true, reply: NEEDS_A_NUMBER };
    }
    return { handled: false };
  }

  if (!isApprover) {
    // Log the attempt even when refusing: an unexpected merge request from
    // another account is exactly the thing someone should be able to find later.
    await logBotAction({
      chatId,
      userId: telegramUserId,
      role: null,
      tool: 'merge_request',
      args: { prNumber: command.prNumber },
      outcome: 'denied',
      detail: approver ? 'sender is not the merge approver' : 'no merge approver configured',
    });
    // In a group, a stray "merge 12" from someone else stays silent rather than
    // announcing that a merge channel exists.
    if (!addressed) return { handled: false };
    return { handled: true, reply: approver ? NOT_ALLOWED : NOT_CONFIGURED };
  }

  if (!fireConfig()) {
    await logBotAction({
      chatId,
      userId: telegramUserId,
      role: null,
      tool: 'merge_request',
      args: { prNumber: command.prNumber },
      outcome: 'failed',
      detail: 'merge routine not configured',
    });
    return { handled: true, reply: NOT_CONFIGURED };
  }

  const fired = await fireMergeRoutine(command.prNumber);
  await logBotAction({
    chatId,
    userId: telegramUserId,
    role: null,
    tool: 'merge_request',
    args: { prNumber: command.prNumber },
    outcome: fired.ok ? 'ran' : 'failed',
    detail: fired.detail,
  });

  if (!fired.ok) {
    return {
      handled: true,
      reply: `Could not start the merge check for #${command.prNumber}. Nothing was merged. Try again or merge from the Claude app.`,
    };
  }

  return {
    handled: true,
    reply:
      `Checking #${command.prNumber} now: review, tests, and whether the branch is current. ` +
      'If it all passes I will merge it and text you back. Nothing is live until then.',
  };
}
