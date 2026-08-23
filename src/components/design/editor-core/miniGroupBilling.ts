// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #334 fix: when staff group ungrouped mini strands/scattershots into one
// billed MiniGroupItem (editor.ts's groupSelectedMini), the new group's
// stringCount must be seeded from the SUM of its members' own counts, not
// just one member's — seeding from a single member silently dropped the
// other members' strings from the bill (grouping a 4-string scattershot with
// a 1-string strand billed 1, an 80% silent under-count with no preview or
// confirm). Summing keeps grouping money-neutral by default; staff can still
// adjust the seeded value afterward via the group's own String count field
// (renderSelectedMiniGroupSidebar in editor.ts), which grouping leaves
// immediately visible since the still-selected members now share a groupId.
//
// Lives in its own module (mirrors the drawContext.ts precedent) rather than
// inside editor.ts because editor.ts imports Konva, which pulls in its Node
// entrypoint's optional `canvas` dependency outside a browser — that makes
// editor.ts itself unimportable in this repo's headless (Node, non-jsdom)
// test environment. Keeping this function Konva-free is what makes it
// unit-testable at all.
import type { StrandItem, MiniAreaItem } from "@/lib/design/sceneTypes";

export function sumMiniStringCount(members: (StrandItem | MiniAreaItem)[]): number {
  return members.reduce((sum, m) => sum + (m.stringCount ?? 1), 0);
}
