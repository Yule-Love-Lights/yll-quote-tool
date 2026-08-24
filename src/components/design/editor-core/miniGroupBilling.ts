// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #334: when staff group ungrouped mini strands/scattershots into one billed
// MiniGroupItem (editor.ts's groupSelectedMini), the new group's stringCount
// is seeded conditionally, not always summed. A prod sweep found 84% of
// grouped members (275/~327) sit at stringCount=1, the untouched default —
// staff routinely trace N segments, group them, then type the TRUE count on
// the GROUP itself (e.g. 23 traced segments grouped, staff types 8). Summing
// unconditionally would seed 23 there, replacing a silent under-count with a
// much larger silent OVER-count that overcharges a real customer. Only a
// small minority of members (~12 repo-wide) carry an explicit count above 1
// before grouping — that minority is the actual row-334 case ("a 4-string
// scattershot grouped with a 1-string strand bills 1").
//
// So: sum the members' own counts ONLY when at least one member carries an
// explicit count > 1 (the trigger for "staff already set per-member counts
// before grouping, and grouping must not discard that"). Otherwise seed
// exactly the CALLER'S pre-#334 fallback, unchanged, because the ordinary
// trace-then-type-the-group-count workflow must keep working exactly as it
// did. `stringCount: 1` cannot be distinguished from "never touched" in the
// stored JSON (both serialize identically) — > 1 is the only usable signal.
// Staff can still adjust either way via the group's own String count field
// (renderSelectedMiniGroupSidebar in editor.ts), which grouping leaves
// immediately visible since the still-selected members now share a groupId.
//
// Lives in its own module (mirrors the drawContext.ts precedent) rather than
// inside editor.ts because editor.ts imports Konva, which pulls in its Node
// entrypoint's optional `canvas` dependency outside a browser — that makes
// editor.ts itself unimportable in this repo's headless (Node, non-jsdom)
// test environment. Keeping these functions Konva-free is what makes them
// unit-testable at all.
import type { StrandItem, MiniAreaItem } from "@/lib/design/sceneTypes";

export function sumMiniStringCount(members: (StrandItem | MiniAreaItem)[]): number {
  return members.reduce((sum, m) => sum + (m.stringCount ?? 1), 0);
}

// The actual per-call-site seed: sum only if triggered, else the caller's own
// historical fallback (which differs by call site — see editor.ts). Each call
// site passes ITS OWN fallback so this never "harmonises" the sites; the only
// thing this function changes is whether an explicit per-member count survives
// grouping.
export function seedGroupStringCount(members: (StrandItem | MiniAreaItem)[], fallback: number): number {
  const hasExplicitCount = members.some((m) => (m.stringCount ?? 1) > 1);
  return hasExplicitCount ? sumMiniStringCount(members) : fallback;
}
