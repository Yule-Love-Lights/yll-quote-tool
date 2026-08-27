// SHARED EDITOR CORE adjacent — pure, no Konva, so it is unit-testable.
//
// Ledger row 434. A mini light group is priced ONLY from its own `stringCount`,
// the number staff type on the group. It is never derived from how many members
// are drawn, and that is deliberate: row 334 proved that summing the members
// over-bills the common case, because staff routinely trace N segments and then
// type the TRUE count on the group (a prod sweep found 84% of grouped members
// sitting at the untouched default of 1).
//
// Row 872 then let staff ADD members to an existing group without the billed
// count changing. Correct by the same reasoning, and the editor warns whenever
// the two diverge. This is the safety net for the case where that warning is
// missed: at SEND time, surface any group whose billed count is lower than the
// number of drawn members, because that is YLL under-charging for work it will
// perform.
//
// Deliberately NOT a customer-accuracy check. The drawn design is a REFERENCE,
// not a promise of exact fixture placement (Naldo, 2026-08-27), so a mismatch is
// not something the customer is owed an explanation for. It is a money check for
// staff, and it is a WARNING rather than a block: a group legitimately billing
// fewer strings than it has drawn segments is a real, intended case.
import { isMiniGroup, isStrand, isMiniArea } from '@/lib/design/sceneTypes';
import type { Scene } from '@/lib/design/sceneTypes';

export type BilledVsDrawn = {
  groupId: string;
  surface: string | null;
  billed: number;
  drawn: number;
};

export function findUnderBilledMiniGroups(scene: Scene | null | undefined): BilledVsDrawn[] {
  if (!scene?.items?.length) return [];
  const out: BilledVsDrawn[] = [];
  for (const item of scene.items) {
    if (!isMiniGroup(item)) continue;
    // Count LIVE members, the same way the editor's own sidebar does: an
    // orphaned memberId (its item deleted on another photo) must not inflate
    // the drawn count and raise a warning about lights nobody can see.
    const drawn = scene.items.filter(
      (i) => (isStrand(i) || isMiniArea(i)) && i.groupId === item.id && item.memberIds.includes(i.id),
    ).length;
    const billed = item.stringCount ?? 1;
    // Only flag UNDER-billing. Billing MORE than is drawn is a normal staff
    // judgement (one drawn run standing in for several real ones) and is not
    // money at risk.
    if (drawn > billed) {
      out.push({ groupId: item.id, surface: item.surface ?? null, billed, drawn });
    }
  }
  return out;
}

export function describeUnderBilledMiniGroups(groups: BilledVsDrawn[]): string {
  const total = groups.reduce((sum, g) => sum + (g.drawn - g.billed), 0);
  const noun = groups.length === 1 ? 'group' : 'groups';
  const parts = groups.map(
    (g) => `${g.surface ?? 'mini'} group billing ${g.billed} for ${g.drawn} drawn`,
  );
  return (
    `${groups.length} mini-light ${noun} bill fewer strings than are drawn ` +
    `(${total} unbilled in total): ${parts.join('; ')}. ` +
    `The drawn design is a reference, so this is not a customer-facing problem, ` +
    `but check the billed counts before sending if this was not intended.`
  );
}
