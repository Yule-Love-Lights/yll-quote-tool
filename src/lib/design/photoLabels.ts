// #13 multi-image: photo display labels + per-line photo tags.
//
// Numbering convention everywhere: the BASE photo is "Photo 1"; extras are
// "Photo 2..N" in extra_photos array order. A staff title always wins over the
// number. Items/lines on the base photo get NO tag (staff read untagged as
// photo 1 — Jason's call, checkpoint 1).

export type PhotoLabelSource = { id: string; title?: string | null };

// extra photo id → display label ("Backyard" or "Photo 3").
export function extraPhotoLabels(extras: PhotoLabelSource[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  (extras ?? []).forEach((p, i) => m.set(p.id, p.title?.trim() || `Photo ${i + 2}`));
  return m;
}

// The photo tag for a priced line: its first scene item that sits on an EXTRA
// photo decides the tag (mini groups span members — any extra-photo member
// tags the line). All-base (or unlinked) lines return null = no tag.
export function photoLabelForLine(
  sceneItemIds: string[] | undefined | null,
  sceneItems: Array<{ id: string; photoId?: string | null }>,
  labels: Map<string, string>,
): string | null {
  if (!sceneItemIds || sceneItemIds.length === 0) return null;
  for (const id of sceneItemIds) {
    const item = sceneItems.find((it) => it.id === id);
    const photoId = item?.photoId ?? null;
    if (photoId) return labels.get(photoId) ?? null;
  }
  return null;
}
