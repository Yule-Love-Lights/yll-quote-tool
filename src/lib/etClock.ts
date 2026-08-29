// Eastern-time conversions for datetime-local form fields (PR #1062 staff
// lens): the business runs on America/New_York, and payroll times typed into
// a form must mean ET no matter what timezone the admin's DEVICE happens to
// be in. Browser-local Date parsing would silently shift a traveling admin's
// entries by hours; these helpers pin both directions to ET, DST-correct.

const ET = 'America/New_York';

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function etParts(d: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const map: Record<string, string> = {};
  for (const p of PARTS_FMT.formatToParts(d)) map[p.type] = p.value;
  return {
    y: Number(map.year),
    mo: Number(map.month),
    d: Number(map.day),
    // Intl renders midnight as '24' under hour12:false in some engines.
    h: Number(map.hour) % 24,
    mi: Number(map.minute),
  };
}

/** ISO instant → the `YYYY-MM-DDTHH:mm` string a datetime-local input shows,
 * rendered in ET. */
export function isoToEtInput(iso: string): string {
  const p = etParts(new Date(iso));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** A `YYYY-MM-DDTHH:mm` string MEANT AS ET → the ISO instant, or null when
 * malformed. Converges on the UTC offset actually in force at that wall time
 * (the etMidnightAfter technique), so March and November come out right. */
export function etInputToIso(local: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  // First guess: treat the wall time as if it were UTC, then correct by the
  // ET offset observed at that instant; repeat once for a DST boundary.
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    const wallAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const target = Date.UTC(y, mo - 1, d, h, mi);
    const diff = target - wallAsUtc;
    if (diff === 0) return new Date(guess).toISOString();
    guess += diff;
  }
  return new Date(guess).toISOString();
}
