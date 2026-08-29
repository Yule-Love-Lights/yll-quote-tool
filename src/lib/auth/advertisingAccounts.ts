import { roleOf } from '@/lib/auth/supabaseServer';

/**
 * Guards for creating an ADVERTISING login (Naldo's 2026-08-27 ruling: a
 * separate population in the shared auth store, marked app_metadata.role =
 * 'advertising'). Deliberately its own door, not a widened validateNewUser —
 * that guard protects the OPERATOR surface and must keep hard-rejecting
 * anything that is not admin/operator (the two-doors-two-guards posture the
 * crew build established).
 */

export type GuardResult = { ok: true } | { ok: false; error: string };

export function validateAdvertisingCredentials(input: { email: string; password: string }): GuardResult {
  const email = (input.email ?? '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'A valid email is required' };
  }
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  return { ok: true };
}

/** The app_metadata written onto an advertising login. `role: 'advertising'`
 * is the single fact the population lock rests on: isAdvertisingAccount reads
 * it, getOperator returns null because of it, and the proxy confines the
 * session because of it. Service-role-only, so a worker cannot edit it away. */
export function advertisingAppMetadata(displayName: string): { role: 'advertising'; name: string } {
  return { role: 'advertising', name: displayName };
}

/** Refuse to create anything that would not read as advertising. Fails loudly
 * if advertisingAppMetadata is ever edited into something roleOf would wave
 * through as a real operator. */
export function advertisingMetadataIsSafe(meta: unknown): boolean {
  const role = (meta as { role?: unknown } | null)?.role;
  return role === 'advertising' && roleOf(meta) === 'operator';
}
