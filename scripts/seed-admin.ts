/* scripts/seed-admin.ts — bootstrap the FIRST operator admin (ledger #81 Slice 3).
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts <email> <password> [name]
 *   # or:  npm run seed-admin -- <email> <password> [name]
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, falling
 * back to .env.local. Creates a confirmed user with app_metadata.role='admin' —
 * the only way to mint the first admin, since the /settings/accounts UI itself
 * requires an existing admin. Run ONCE, before flipping AUTH_GATE_ENABLED.
 *
 * The service-role key bypasses RLS and can manage all users — never commit it
 * and never expose it to the browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Minimal .env.local loader (tsx doesn't auto-load it like Next does). Only sets
// vars that aren't already present in the ambient environment.
function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // no .env.local — rely on the ambient environment
  }
}

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim();
  const password = process.argv[3] ?? '';
  const name = (process.argv[4] ?? '').trim();
  if (!email || !password) {
    console.error('Usage: npx tsx scripts/seed-admin.ts <email> <password> [name]');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Invalid email.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  loadEnvLocal();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (env or .env.local).');
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // name (optional) rides app_metadata alongside role — admin-only, same as the
    // operator-accounts UI sets it (#81 display names).
    app_metadata: { role: 'admin', ...(name ? { name } : {}) },
  });
  if (error || !data.user) {
    console.error(`Failed to create admin: ${error?.message ?? 'unknown error'}`);
    process.exit(1);
  }
  console.log(`Admin created: ${name || data.user.email} (${data.user.id})`);
  console.log('Next: log in at /login, verify the flow, then set AUTH_GATE_ENABLED=true in Vercel.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
