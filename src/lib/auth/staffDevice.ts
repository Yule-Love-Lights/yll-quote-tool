// Staff-device marker (ledger S22 — staff-view suppression).
//
// A staff member opening a customer's /portal/[id] link should NOT be recorded
// as a customer view/interest, nor trigger the staff "your quote was viewed"
// email. The customer-signal routes (/view, /interested) already tried to skip a
// staff preview via getOperator() — but that's the #81 operator SESSION, which
// is inert while the auth gate is dormant (staff never log in). This cookie is
// the no-login bridge: any browser that has visited the operator console is
// marked a staff device (POST /api/operator/mark-device, fired by OperatorShell),
// and the signal routes skip when it's present.
//
// When operator login goes live, getOperator() becomes the authoritative signal;
// this cookie stays as a belt-and-suspenders (and keeps working on a staff
// browser that isn't logged in).

import type { NextRequest } from 'next/server';
import { getOperator } from './supabaseServer';

/** httpOnly cookie set on staff browsers. Value '1' = staff device. */
export const STAFF_DEVICE_COOKIE = 'yll_staff_device';

/**
 * True when this request is a STAFF preview of a portal link — either the
 * browser is marked a staff device (cookie) OR there's a live operator session
 * (once #81 auth is enabled). Either way the customer-signal routes should skip
 * recording/notifying. The cheap sync cookie check comes first so a staff
 * preview usually avoids the getOperator() round-trip entirely.
 */
export async function isStaffPreview(req: NextRequest): Promise<boolean> {
  if (req.cookies.get(STAFF_DEVICE_COOKIE)?.value === '1') return true;
  return !!(await getOperator());
}
