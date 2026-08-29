// Display-only role hint (ops suggestions round, 2026-08-29). The last
// session answer, echoed to localStorage so OperatorNav can render the
// admin-only View-as strip one effect tick after hydration instead of
// waiting the GET /api/auth/session round trip on every page mount.
//
// This is a HINT, never an authority: the session fetch overwrites it every
// page load, every strip destination is server-gated on the real role, and
// a hand-edited value can only paint a strip whose clicks bounce. The
// server-render-the-role alternative is impossible here: about two dozen
// 'use client' surfaces (QuoteBuilder among them) render OperatorShell, and
// a client component cannot render an async server component.

export type RoleHint = 'admin' | 'operator';

export const ROLE_HINT_KEY = 'yll-op-role-hint';

export function readRoleHint(): RoleHint | null {
  try {
    const v = localStorage.getItem(ROLE_HINT_KEY);
    return v === 'admin' || v === 'operator' ? v : null;
  } catch {
    return null; // SSR, private mode, or blocked storage: no hint, no crash
  }
}

/** null clears the hint (a confirmed signed-out browser keeps nothing). */
export function writeRoleHint(role: RoleHint | null): void {
  try {
    if (role === null) localStorage.removeItem(ROLE_HINT_KEY);
    else localStorage.setItem(ROLE_HINT_KEY, role);
  } catch {
    // best effort only
  }
}
