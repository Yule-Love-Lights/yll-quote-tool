// Coverage for persistCommitments -- proves the wrapper calls
// call_commitments_finalize_extraction with the right args (including the
// rep-assignment ruling's p_assigned_to) and interprets every documented
// result ('ok' / 'already_finalized' / 'refused' / anything else) correctly.
// The RPC's own atomicity/TOCTOU-closing logic is NOT retested here (it
// cannot run under vitest -- see this slice's build notes for the
// line-by-line cross-read against the copilot source that verifies it
// instead).

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistCommitments } from './persist';
import type { CommitmentRow } from './types';

function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const ROWS: CommitmentRow[] = [
  { kind: 'send_quote', detail: 'send the quote', promised_at: null, extraction_index: 0 },
];

describe('persistCommitments', () => {
  it('calls the finalize RPC with the transcript id, mapped rows, extractor version, and resolved assignedTo', async () => {
    const { client, rpc } = fakeSupabase({ data: 'ok', error: null });

    await persistCommitments(client, 't-1', 'rep@example.com', 'contact-1', ROWS, 'claude-haiku-4-5-20251001', 'operator-1');

    expect(rpc).toHaveBeenCalledWith('call_commitments_finalize_extraction', {
      p_transcript_id: 't-1',
      p_rows: [
        {
          ghl_contact_id: 'contact-1',
          rep_email: 'rep@example.com',
          kind: 'send_quote',
          detail: 'send the quote',
          promised_at: null,
          extraction_index: 0,
        },
      ],
      p_extractor_version: 'claude-haiku-4-5-20251001',
      p_assigned_to: 'operator-1',
    });
  });

  it('passes assignedTo=null when no operator was matched', async () => {
    const { client, rpc } = fakeSupabase({ data: 'ok', error: null });
    await persistCommitments(client, 't-1', null, null, ROWS, 'v1', null);
    expect(rpc).toHaveBeenCalledWith('call_commitments_finalize_extraction', expect.objectContaining({ p_assigned_to: null }));
  });

  it('returns ok/alreadyFinalized=false on "ok"', async () => {
    const { client } = fakeSupabase({ data: 'ok', error: null });
    const result = await persistCommitments(client, 't-1', null, null, ROWS, 'v1', null);
    expect(result).toEqual({ ok: true, alreadyFinalized: false });
  });

  it('returns ok/alreadyFinalized=true on "already_finalized"', async () => {
    const { client } = fakeSupabase({ data: 'already_finalized', error: null });
    const result = await persistCommitments(client, 't-1', null, null, ROWS, 'v1', null);
    expect(result).toEqual({ ok: true, alreadyFinalized: true });
  });

  it('returns the has_resolved_commitments refusal on "refused" -- the never-relabel-a-settled-commitment guard firing', async () => {
    const { client } = fakeSupabase({ data: 'refused', error: null });
    const result = await persistCommitments(client, 't-1', null, null, ROWS, 'v1', null);
    expect(result).toEqual({ ok: false, reason: 'has_resolved_commitments' });
  });

  it('throws on a Postgres/PostgREST error', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'boom' } });
    await expect(persistCommitments(client, 't-1', null, null, ROWS, 'v1', null)).rejects.toEqual({ message: 'boom' });
  });

  it('throws on an unexpected (unrecognized) RPC result rather than silently succeeding', async () => {
    const { client } = fakeSupabase({ data: 'some-unknown-result', error: null });
    await expect(persistCommitments(client, 't-1', null, null, ROWS, 'v1', null)).rejects.toThrow(
      /Unexpected commitment finalizer result/,
    );
  });
});
