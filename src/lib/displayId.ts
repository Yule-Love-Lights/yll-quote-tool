// Sequential human-friendly display numbers (ledger #83, SPEC §4.6).
//
// Each object type (quote / job / invoice) gets its own monotonic Postgres
// SEQUENCE; the display number is allocated from it on first insert. The UUID
// stays the primary key + the non-guessable portal token — the display number
// is for staff/phone/email reference only and NEVER appears in a URL.
//
// supabase-js can't issue a raw `select nextval(...)`, so we go through a
// SECURITY DEFINER RPC (`allocate_display_number`, defined in the Phase-1
// migration) that returns `nextval(seq)`. Same RPC pattern as
// match_training_examples. Server-only — uses the service-role client.

import { getSupabaseServiceClient } from './supabase';

// The sequences this allocator knows about. Locked to the named sequences the
// migrations create so a typo can't ask the RPC for an arbitrary relation.
// quote_number_seq → 2026-06-27-quote-status.sql (#83 P1);
// job_number_seq   → 2026-06-27-jobs.sql (#83 P2). invoice_number_seq lands P3.
export type DisplaySequence = 'quote_number_seq' | 'job_number_seq';

/**
 * Allocate the next value from a Postgres sequence. Monotonic + gap-tolerant
 * (a rolled-back insert burns a number — fine, these are reference labels, not
 * an accounting series). Throws if Supabase isn't configured or the RPC errors,
 * so a caller can decide whether a missing display number should block the save.
 */
export async function allocateNumber(seq: DisplaySequence): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('allocateNumber: Supabase service client not configured');

  const { data, error } = await sb.rpc('allocate_display_number', { seq_name: seq });
  if (error) {
    throw new Error(`allocateNumber(${seq}): ${error.message}`);
  }
  // The RPC returns a single bigint (nextval). supabase-js hands it back as a
  // number (it's well within Number.MAX_SAFE_INTEGER for any realistic count).
  const n = typeof data === 'number' ? data : Number(data);
  if (!Number.isFinite(n)) {
    throw new Error(`allocateNumber(${seq}): RPC returned a non-numeric value: ${String(data)}`);
  }
  return n;
}
