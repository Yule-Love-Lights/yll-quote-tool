/**
 * The money decisions behind a bulk photo ingest, as pure functions so they
 * can be tested without a database or a folder of photos.
 *
 * Context: an admin hands over a folder of photos, a crew member and a
 * campaign, and every photo that lands ACCEPTED pays that worker the
 * campaign's current rate. Naldo's rule for this (2026-09-01) is that the
 * dollar total is counted back to him BEFORE the full run, so the arithmetic
 * behind that number is the part that has to be right: a duplicate pays
 * nothing, an unusable file pays nothing, and the total is the count of rows
 * that will really be created times the rate, in whole cents.
 */

export type IngestCandidate = {
  /** File name as it will be reported back, not a path. */
  file: string;
  bytes: number;
  lat: number | null;
  lng: number | null;
  /** ISO string from the photo's own EXIF, or null when it carries none. */
  takenAt: string | null;
  photoHash: string | null;
  /** Set when this exact photo is already an accepted, unvoided row. */
  duplicateOfPlacementId: string | null;
  /** Set when an EARLIER file in this same batch carries the same hash. The
   * pipeline would skip it as a duplicate at write time, so the total read
   * back before the run has to account for it too. */
  duplicateOfFile: string | null;
  /** Set when the file cannot be sent at all. Wins over duplicate. */
  problem: string | null;
};

export type IngestPlan = {
  send: IngestCandidate[];
  duplicates: IngestCandidate[];
  problems: IngestCandidate[];
  /** What the run will pay, in whole cents. Only `send` earns. */
  payCents: number;
  totalFiles: number;
};

export function planIngest(candidates: IngestCandidate[], rateCents: number): IngestPlan {
  if (!Number.isInteger(rateCents) || rateCents < 0) {
    throw new Error(`planIngest: the rate must be a whole number of cents, got ${rateCents}`);
  }
  const problems: IngestCandidate[] = [];
  const duplicates: IngestCandidate[] = [];
  const send: IngestCandidate[] = [];
  for (const c of candidates) {
    // A file that cannot be sent is a problem first, whatever else is true
    // of it: reporting it as a duplicate would imply we already hold a paid
    // copy, which is a different and much calmer fact.
    if (c.problem) problems.push(c);
    else if (c.duplicateOfPlacementId || c.duplicateOfFile) duplicates.push(c);
    else send.push(c);
  }
  return {
    send,
    duplicates,
    problems,
    payCents: send.length * rateCents,
    totalFiles: candidates.length,
  };
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type Named = { id: string; name: string };

export type Resolution<T> =
  | { ok: true; row: T }
  | { ok: false; reason: string };

/**
 * Resolve a worker or a campaign from what the admin typed. An id wins
 * outright; otherwise the name must match exactly (ignoring case and
 * surrounding space). Two rows sharing a name is a REFUSAL, never a guess:
 * picking the wrong one here pays the wrong person.
 */
export function resolveByNameOrId<T extends Named>(rows: T[], query: string, label: string): Resolution<T> {
  const q = query.trim();
  if (!q) return { ok: false, reason: `Name the ${label}.` };

  const byId = rows.filter((r) => r.id === q);
  if (byId.length === 1) return { ok: true, row: byId[0] };

  const lower = q.toLowerCase();
  const byName = rows.filter((r) => r.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, row: byName[0] };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: `More than one ${label} is called "${q}" (${byName.map((r) => r.id).join(', ')}). Give the id instead.`,
    };
  }
  return {
    ok: false,
    reason: `No ${label} matches "${q}". Known: ${rows.map((r) => r.name).join(', ') || 'none'}.`,
  };
}
