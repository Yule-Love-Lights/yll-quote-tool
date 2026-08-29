/**
 * What a CREW login looked like.
 *
 * Crew logins were RETIRED on 2026-08-28 (ledger row 438). The `/api/ops/v1`
 * surface they existed to reach went with the Operations Hub (row 433), so a
 * crew login could reach nothing at all, and prod never held one: the account
 * population was measured at zero crew, three operator, three admin before the
 * minting path was removed. Field crew work through the Telegram bot instead.
 *
 * The MINTING guards are gone with the minting. This helper stays because the
 * marker itself still matters: `isCrewAccount` reads `role: 'crew'`, and
 * `getOperator` returns null on it. That rejection is the fail-closed guard
 * against the escalation recorded in AGENTS.md (roleOf collapses every
 * non-admin role, 'crew' included, to 'operator'), so it must keep working even
 * though nothing mints these any more. `crewGuard.test.ts` uses this to build a
 * crew account and prove the admin-users routes still refuse one.
 */
export function crewAppMetadata(displayName: string): { role: 'crew'; name: string } {
  return { role: 'crew', name: displayName };
}
