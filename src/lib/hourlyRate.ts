/**
 * Parse a dollars-and-cents hourly rate string into INTEGER CENTS.
 *
 * Money is stored as integer cents (`crew_members.base_rate_cents`), so the
 * dollars-to-cents conversion happens here, once, on the server, from the string
 * the office typed — never by multiplying a float by 100 (0.1 * 100 is
 * 10.000000000000002 in IEEE-754). We add integer whole-dollar and cent parts
 * instead, so the result is exact for every valid input.
 *
 * Accepts: "22", "22.5", "22.50", " $1,250.00 ". Rejects: "", "abc", "-5",
 * "1.234" (more than two decimal places), and anything above the cap (a typo
 * guard — no office hourly rate is $10,000).
 *
 * Returns the integer cents (>= 0), or null if the input is not a valid,
 * in-range rate. Zero is allowed on purpose: the owner is office staff and may
 * not pay themselves an hourly wage, but the field is still entered deliberately.
 */
export function dollarsToCents(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  // Strip a leading $, thousands separators, and surrounding whitespace.
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [wholePart, fracPartRaw = ''] = cleaned.split('.');
  const fracPart = fracPartRaw.padEnd(2, '0'); // "5" -> "50", "" -> "00"
  const cents = Number(wholePart) * 100 + Number(fracPart);
  if (!Number.isSafeInteger(cents)) return null;

  const CAP_CENTS = 1_000_000; // $10,000/hr — a typo guard, not a business rule
  if (cents > CAP_CENTS) return null;
  return cents;
}
