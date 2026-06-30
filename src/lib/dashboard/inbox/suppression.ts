// Layer-3 sender suppression (#58 v2). A dashboard-owned list of senders whose
// future messages auto-classify as 'automated'. Stored as the app_settings row
// keyed 'dashboard.suppressedSenders' (a string[]), read/written directly via the
// service-role client — kept out of Jason's appSettings.ts so this stays in-area.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { normalizeEmail, normalizePhone } from './normalize';

const KEY = 'dashboard.suppressedSenders';

/** Normalize raw sender identifiers (emails → lowercased, phones → E.164), drop blanks + dupes. */
export function normalizeSuppressionValues(values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const s = v.trim();
    if (!s) continue;
    const email = s.includes('@') ? normalizeEmail(s) : null;
    const phone = !email ? normalizePhone(s) : null;
    // Only suppress on a value that normalizes to a real email or phone — a
    // malformed identifier would never match a future sender and would just
    // grow the stored list as garbage.
    const norm = email ?? phone;
    if (norm) out.add(norm);
  }
  return [...out];
}

/** The current suppression set (normalized). Fail-safe: empty set on any error. */
export async function getSuppressedSenders(): Promise<Set<string>> {
  const sb = getSupabaseServiceClient();
  if (!sb) return new Set();
  const { data, error } = await sb.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error || !data) return new Set();
  const list = Array.isArray((data as { value?: unknown }).value) ? ((data as { value: unknown[] }).value as unknown[]) : [];
  return new Set(normalizeSuppressionValues(list.map((x) => (typeof x === 'string' ? x : null))));
}

/** Add senders to the suppression list (idempotent, normalized). Best-effort. */
export async function addSuppressedSenders(values: (string | null | undefined)[]): Promise<void> {
  const additions = normalizeSuppressionValues(values);
  if (!additions.length) return;
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const current = await getSuppressedSenders();
  for (const a of additions) current.add(a);
  await sb.from('app_settings').upsert({ key: KEY, value: [...current] }, { onConflict: 'key' });
}
