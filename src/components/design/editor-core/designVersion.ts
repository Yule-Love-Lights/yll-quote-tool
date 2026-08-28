// Row 371 (final pre-merge verify, HIGH): when the server prunes a design's
// scene on its own — today, a photo delete — it hands the new CAS version back
// so the still-mounted editor is not left a version behind (which used to fail
// its next save with "Save blocked — reload" and discard a live edit).
//
// But a version number is a claim about CONTENT, and this client never re-reads
// that content: it fetches the design once at mount. The prune re-reads the row
// fresh on every attempt, so the version it writes can represent ANOTHER
// operator's edit that this client has never seen. Adopting it blindly would
// let this client's next save pass the compare-and-swap and overwrite that
// edit — turning a noisy-but-safe false conflict into a silent lost update, on
// the items that get billed and installed.
//
// So adoption is allowed only when the version moved by exactly one. That is
// the arithmetic signature of "the prune wrote on top of the very version I
// already hold, and nobody else got in between". Any other gap means somebody
// did, and the correct outcome is the conflict this client would have hit
// anyway — no worse than before this row, and never a silent overwrite.
//
// Konva-free on purpose (mirroring drawContext.ts and lightScale.ts): editor.ts
// itself cannot be imported in this repo's headless test environment, so the
// rule lives where it can actually be tested.
export function shouldAdoptPrunedVersion(
  current: number | null | undefined,
  serverVersion: number | null | undefined,
): boolean {
  if (typeof serverVersion !== 'number' || !Number.isFinite(serverVersion)) return false;
  if (typeof current !== 'number' || !Number.isFinite(current)) return false;
  return serverVersion === current + 1;
}
