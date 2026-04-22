import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Module-level cache — Next.js reuses the module across API route calls in a
// single server runtime, so we get one SupabaseClient per process instead of
// a fresh one per request. The client is cheap but not free; each
// createClient() call allocates fetch internals and an auth state machine.
let cached: SupabaseClient | null = null;
let cachedKey: string | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // Invalidate cache if env vars were swapped at runtime (rare but possible
  // during local dev). Key on url+anon_key so a change forces a new client.
  const k = `${url}::${key}`;
  if (cached && cachedKey === k) return cached;
  cached = createClient(url, key);
  cachedKey = k;
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}
