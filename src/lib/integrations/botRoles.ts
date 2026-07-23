// src/lib/integrations/botRoles.ts
// Role tiers for the staff text-ops bot (Phase 2 of the 2026-07-19 plan).
//
// TWO SEPARATE GATES, deliberately keyed to different ids:
//   • the ALLOWLIST (telegram.ts isAllowedChat) gates the ROOM — which chats the
//     bot will answer in at all.
//   • the ROLE here gates the PERSON — what the sender may do once inside.
// They must not be merged: in a staff GROUP chat the room is one id while Naldo,
// Jason, and a crew installer are three different senders who may not have the
// same powers. Keying roles to the chat would hand everyone in the room the
// highest role present.
//
// Fails closed at every step: an unknown sender has no role, and a sender who is
// allowlisted but unassigned lands on the LEAST privileged tier (crew), never on
// staff/admin by default.
//
// Env (comma-separated Telegram USER ids, from message.from.id):
//   TELEGRAM_ADMIN_USERS   Naldo, Jason — settings, bot administration, approvals
//   TELEGRAM_STAFF_USERS   office team — CRM + money writes, no settings
//   TELEGRAM_CREW_USERS    field installers — reads + field capture only

export type BotRole = 'crew' | 'staff' | 'admin';

// Higher rank satisfies any lower minimum. Ordering is the whole permission
// model — the per-tool minimums below are just a rank comparison.
const ROLE_RANK: Record<BotRole, number> = { crew: 1, staff: 2, admin: 3 };

function idsFrom(envValue: string | undefined): string[] {
  return (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The sender's role, or null when they aren't configured anywhere.
 *
 * Checked highest-first so a person listed in two tiers gets the higher one
 * (a typo that lists Naldo as both admin and crew must not demote him).
 * Returns null rather than a default role: the caller decides whether an
 * unassigned-but-allowlisted sender gets `crew` (see roleForSenderInAllowedChat).
 */
export function roleForUser(userId: string | number | null | undefined): BotRole | null {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  if (idsFrom(process.env.TELEGRAM_ADMIN_USERS).includes(id)) return 'admin';
  if (idsFrom(process.env.TELEGRAM_STAFF_USERS).includes(id)) return 'staff';
  if (idsFrom(process.env.TELEGRAM_CREW_USERS).includes(id)) return 'crew';
  return null;
}

/**
 * The effective role for a sender whose CHAT already passed the allowlist.
 *
 * Least-privilege fallback: the room was explicitly allowlisted, so the sender
 * is trusted enough to read and to capture field work, but an unassigned person
 * never inherits money or settings powers. This keeps a brand-new crew member
 * working the moment they're added to the group, without a silent privilege
 * grant if someone forgets to list them.
 */
export function roleForSenderInAllowedChat(userId: string | number | null | undefined): BotRole {
  return roleForUser(userId) ?? 'crew';
}

/** True when `actual` satisfies the `minimum` tier. */
export function hasRole(actual: BotRole, minimum: BotRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

/**
 * The higher-ranked of two roles (either may be null), or null when both are.
 *
 * This is how the DB roster and the env floor combine (see botUsers
 * resolveSenderRole): taking the HIGHER means a bad or missing DB edit can never
 * demote a bootstrap admin below their env role, so the owners can't lock
 * themselves out of the bot by editing the roster.
 */
export function higherRole(a: BotRole | null, b: BotRole | null): BotRole | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

// The minimum role per bot tool. Mirrors the permission matrix locked with
// Naldo (2026-07-19/20) in docs/superpowers/plans/2026-07-19-text-ops-bot-and-
// yll-ops-tool-layer.md — matrix rows in brackets. Anything not listed here is
// unknown to the bot and is refused by lookup, so adding a tool without a
// deliberate role entry cannot accidentally ship as world-open.
export const TOOL_MIN_ROLE = {
  // Reads [rows 1-4]
  status: 'crew',
  schedule: 'crew',
  stock: 'crew',
  low: 'crew',
  jobs: 'crew',
  help: 'crew',
  // Field capture [rows 7-10]
  completeInstall: 'crew',
  captureLead: 'crew',
  // Legacy keyword writes, staff+ [row 9 is crew, but these move REAL stock]
  move: 'crew',
  prep: 'staff',
  set: 'staff',
} as const satisfies Record<string, BotRole>;

export type BotToolName = keyof typeof TOOL_MIN_ROLE;

export function isKnownTool(name: string): name is BotToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_MIN_ROLE, name);
}

/**
 * Permission check for one tool call. Unknown tool names are refused rather
 * than defaulted — see TOOL_MIN_ROLE.
 */
export function mayRunTool(role: BotRole, tool: string): boolean {
  if (!isKnownTool(tool)) return false;
  return hasRole(role, TOOL_MIN_ROLE[tool]);
}
