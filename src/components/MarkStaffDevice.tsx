'use client';

import { useEffect } from 'react';

// Marks this browser as a STAFF device (ledger S22 — staff-view suppression).
// Mounted by OperatorShell, so any browser that opens the operator console gets
// the yll_staff_device cookie; the customer-signal routes (/view, /interested)
// then skip a staff preview of a customer's portal link. Fire-and-forget; a
// sessionStorage guard keeps it to one POST per tab session (the cookie itself
// lives a year — this just refreshes it and avoids a POST on every navigation).
// The customer portal never renders OperatorShell, so this never runs there.
export function MarkStaffDevice() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem('yll_staff_marked') === '1') return;
      sessionStorage.setItem('yll_staff_marked', '1');
    } catch {
      // sessionStorage unavailable (private mode / blocked) — still mark once.
    }
    fetch('/api/operator/mark-device', { method: 'POST', keepalive: true }).catch(() => {
      /* best-effort */
    });
  }, []);
  return null;
}
