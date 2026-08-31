// The shape contract between the admin issuances route and the allotment
// section, kept as a tested pure function because the first cut of that
// section read the wrong key off the response and rendered nothing at all,
// while still clearing its own error state so it looked like a successful
// empty load (two lenses, PR #1135). A component with a fetch inside it is
// awkward to test; this is the part worth pinning, and its test asserts
// against what the route actually returns.

export type AllotmentRow = {
  workerId: string;
  displayName: string;
  active: boolean;
  issuedTotal: number;
  signsUsed: number;
  remaining: number;
};

type RawRow = Partial<AllotmentRow> & { isTest?: boolean };

/** PURE. Reads the route's payload into rows for display. An unusable body
 * yields null, which the caller must render as a failure rather than as an
 * empty list: "no crew yet" and "the read broke" are different facts. Test
 * workers are dropped, matching the pay section on the same screen. */
export function parseAllotments(body: unknown): AllotmentRow[] | null {
  const balances = (body as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(balances)) return null;
  const rows: AllotmentRow[] = [];
  for (const raw of balances as RawRow[]) {
    if (!raw || typeof raw.workerId !== 'string') return null;
    if (raw.isTest) continue;
    rows.push({
      workerId: raw.workerId,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : '(unknown worker)',
      active: raw.active !== false,
      issuedTotal: Number(raw.issuedTotal ?? 0),
      signsUsed: Number(raw.signsUsed ?? 0),
      remaining: Number(raw.remaining ?? 0),
    });
  }
  return rows;
}
