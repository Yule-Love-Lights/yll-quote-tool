import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Module-level cache — Next.js reuses the module across API route calls in a
// single server runtime, so we get one SupabaseClient per process instead of
// a fresh one per request. The client is cheap but not free; each
// createClient() call allocates fetch internals and an auth state machine.
let cached: SupabaseClient | null = null;
let cachedKey: string | null = null;
let cachedService: SupabaseClient | null = null;
let cachedServiceKey: string | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const k = `${url}::${key}`;
  if (cached && cachedKey === k) return cached;
  cached = createClient(url, key);
  cachedKey = k;
  return cached;
}

// Service-role client bypasses RLS. ONLY use from server-side code (never
// exposed to the browser). Used by server-side reads/writes (portal loader,
// designs, admin routes) that must see rows the anon policies would hide.
export function getSupabaseServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const k = `${url}::${key}`;
  if (cachedService && cachedServiceKey === k) return cachedService;
  cachedService = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedServiceKey = k;
  return cachedService;
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

export function isSupabaseServiceConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
