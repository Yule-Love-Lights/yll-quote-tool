// Escalation scoring + outbound auto-resolve. Pure: every function takes the
// relevant instants explicitly (no Date.now), so escalation is deterministic and
// testable. The cron passes `now`.
//
// Confirmed with Naldo 2026-06-28:
//   • #1 pain is REPLYING TOO LATE → aggressive timing: amber > 1h, red > 4h.
//   • escalation is TEAM-WIDE (shared queue) — these functions never look at an
//     assignee; an unclaimed item escalates exactly like a claimed one. Recipient
//     selection (whole team + sales@yulelovelights.com) lives in the cron route.
//   • all day-boundary logic is America/New_York (via normalize's ET helpers).

import type { EscalationLevel } from './types';
import { ESCALATION_LEVEL } from './types';
import { etDayKey, etHour } from './normalize';

export const ESCALATION = {
  amberAfterMs: 1 * 3_600_000, // > 1h
  redAfterMs: 4 * 3_600_000, // > 4h
  eodHourEt: 17, // 5pm ET end-of-day digest cutoff
} as const;

/** Time-based level for an UNHANDLED item: NONE | AMBER | RED. */
export function escalationLevel(lastMessageAt: Date, now: Date): EscalationLevel {
  const ageMs = now.getTime() - lastMessageAt.getTime();
  if (ageMs >= ESCALATION.redAfterMs) return ESCALATION_LEVEL.RED;
  if (ageMs >= ESCALATION.amberAfterMs) return ESCALATION_LEVEL.AMBER;
  return ESCALATION_LEVEL.NONE;
}

/**
 * The escalation level to email RIGHT NOW, or null. Returns the current level
 * only when it's non-zero and not already in notified_levels — so each of
 * amber/red fires its targeted alert exactly once.
 */
export function newlyCrossedLevel(
  lastMessageAt: Date,
  now: Date,
  notifiedLevels: number[],
): number | null {
  const level = escalationLevel(lastMessageAt, now);
  if (level === ESCALATION_LEVEL.NONE) return null;
  return notifiedLevels.includes(level) ? null : level;
}

/**
 * Whether an unhandled item belongs in today's end-of-day digest. Gated on the
 * item being at least amber-aged (genuinely pending, not a message that landed
 * five minutes before the cutoff), then true once we've reached the ET EOD hour
 * on its day OR it has survived into a later ET day. Re-evaluates daily with no
 * dedupe, so the digest "rolls into the next day" until handled.
 */
export function isDueForEodDigest(lastMessageAt: Date, now: Date): boolean {
  if (now.getTime() - lastMessageAt.getTime() < ESCALATION.amberAfterMs) return false;
  const msgDay = etDayKey(lastMessageAt);
  const nowDay = etDayKey(now);
  if (nowDay > msgDay) return true; // YYYY-MM-DD is lexicographically sortable
  return etHour(now) >= ESCALATION.eodHourEt;
}

/**
 * Outbound-reply auto-resolve (Gmail / timestamp-based): an outbound message
 * after the last inbound means we've already replied → clear the card. An
 * outbound with no prior inbound (we initiated) also counts as answered.
 */
export function isAnsweredByOutbound(input: {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
}): boolean {
  if (!input.lastOutboundAt) return false;
  if (!input.lastInboundAt) return true;
  return input.lastOutboundAt.getTime() > input.lastInboundAt.getTime();
}

/**
 * Outbound-reply auto-resolve (GHL): the spike showed message-level direction is
 * unreliable for email/call, but the conversation-level lastMessageDirection is
 * always present → use it directly.
 */
export function isAnsweredByDirection(lastMessageDirection: string | null | undefined): boolean {
  return lastMessageDirection === 'outbound';
}
