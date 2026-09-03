// Who is signed in, as the header account menu shows it. PURE — no IO, no
// React — so the naming rules are unit-tested rather than eyeballed on screen.
//
// The session answer (GET /api/auth/session) carries a name and an email, and
// either can be missing: an account created straight in the Supabase dashboard
// has no name, and the pre-fetch render has neither.

export type AccountIdentity = {
  name: string | null;
  email: string | null;
  role: 'admin' | 'operator' | null;
};

/**
 * The name to print. Falls back to the email, then to a neutral word — never
 * to an empty string, which would render an account menu that names nobody.
 */
export function displayName(id: AccountIdentity): string {
  const name = id.name?.trim();
  if (name) return name;
  const email = id.email?.trim();
  if (email) return email;
  return 'Signed in';
}

/**
 * One or two letters for the compact button that replaces the full name below
 * 1280px, where the header row has no width to spare. Initials of the first
 * and last word of a real name; otherwise the first letter of the email.
 */
export function initials(id: AccountIdentity): string {
  const name = id.name?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  const email = id.email?.trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return '··';
}

/** The role, spelled the way a person would say it. Null before it resolves. */
export function roleLabel(role: 'admin' | 'operator' | null): string | null {
  if (role === 'admin') return 'Admin';
  if (role === 'operator') return 'Operator';
  return null;
}
