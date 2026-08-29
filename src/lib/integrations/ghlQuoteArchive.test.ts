import { describe, it, expect } from 'vitest';
import {
  archiveStageMap,
  outcomeForStageId,
  asArchiveOutcome,
  ARCHIVABLE_FROM,
  decideArchive,
  type ArchiveCandidate,
} from './ghlQuoteArchive';
import { allPipelineStages } from './ghlPipelineMap';
import { QUOTE_STATUSES } from '@/lib/quoteStatus';

const candidate = (over: Partial<ArchiveCandidate> = {}): ArchiveCandidate => ({
  status: 'sent',
  customerApprovedAt: null,
  depositPaidAt: null,
  viewOnly: false,
  ...over,
});

describe('GHL stage to archive outcome (S75)', () => {
  it('recognises every declined and abandoned stage in every pipeline', () => {
    for (const stages of allPipelineStages()) {
      expect(outcomeForStageId(stages.declined)).toBe('declined');
      // Neighbors reuses its Declined id for abandoned, so that one id reads
      // as a decline. Every other pipeline maps its own abandoned stage.
      const abandonedReading = outcomeForStageId(stages.abandoned);
      expect(abandonedReading).toBe(stages.abandoned === stages.declined ? 'declined' : 'abandoned');
    }
  });

  it('reads an ordinary pipeline move as no archive at all', () => {
    for (const stages of allPipelineStages()) {
      expect(outcomeForStageId(stages.entry)).toBeNull();
      expect(outcomeForStageId(stages.sent)).toBeNull();
      expect(outcomeForStageId(stages.depositPaid)).toBeNull();
      expect(outcomeForStageId(stages.installed)).toBeNull();
    }
  });

  it('reads a blank, missing, or unknown stage id as no archive', () => {
    expect(outcomeForStageId(null)).toBeNull();
    expect(outcomeForStageId(undefined)).toBeNull();
    expect(outcomeForStageId('   ')).toBeNull();
    expect(outcomeForStageId('not-a-stage-id')).toBeNull();
  });

  it('never maps one stage id to two meanings', () => {
    const map = archiveStageMap();
    for (const [, outcome] of map) expect(['declined', 'abandoned']).toContain(outcome);
  });

  it('accepts only the two explicit outcome names a workflow may send', () => {
    expect(asArchiveOutcome('declined')).toBe('declined');
    expect(asArchiveOutcome('abandoned')).toBe('abandoned');
    for (const bad of ['cancelled', 'booked', 'DECLINED', '', null, undefined, 1, {}]) {
      expect(asArchiveOutcome(bad)).toBeNull();
    }
  });
});

describe('archive decision: the money guard (S75, Naldo 2026-08-29)', () => {
  it('never archives an approved quote, even though a hand decline is legal from approved', () => {
    const d = decideArchive(candidate({ status: 'approved' }));
    expect(d).toEqual({ action: 'refuse', reason: 'has-money' });
    expect(ARCHIVABLE_FROM).not.toContain('approved');
  });

  it('never archives a booked quote', () => {
    expect(decideArchive(candidate({ status: 'booked' }))).toEqual({
      action: 'refuse',
      reason: 'has-money',
    });
  });

  it('refuses on the money TIMESTAMPS even when the status column disagrees', () => {
    // A legacy row can carry the timestamps with a stale or null status.
    expect(decideArchive(candidate({ status: 'sent', customerApprovedAt: '2026-08-01T00:00:00Z' })))
      .toEqual({ action: 'refuse', reason: 'has-money' });
    expect(decideArchive(candidate({ status: 'viewed', depositPaidAt: '2026-08-01T00:00:00Z' })))
      .toEqual({ action: 'refuse', reason: 'has-money' });
  });

  it('archives a live, unpaid quote from every status that should allow it', () => {
    for (const status of ['draft', 'sent', 'viewed', 'changes_requested'] as const) {
      expect(decideArchive(candidate({ status }))).toEqual({ action: 'archive' });
      expect(decideArchive(candidate({ status }))).toEqual({ action: 'archive' });
    }
  });

  it('is idempotent: a repeat webhook for the same drag changes nothing', () => {
    expect(decideArchive(candidate({ status: 'declined' }))).toEqual({
      action: 'skip',
      reason: 'already-terminal',
    });
  });

  it('leaves a quote already closed under another name alone, and does not call it an error', () => {
    expect(decideArchive(candidate({ status: 'abandoned' }))).toEqual({
      action: 'skip',
      reason: 'already-terminal',
    });
    expect(decideArchive(candidate({ status: 'cancelled' }))).toEqual({
      action: 'skip',
      reason: 'already-terminal',
    });
  });

  it('leaves a staff-parked view-only quote alone, mirroring staff-abandon', () => {
    expect(decideArchive(candidate({ status: 'sent', viewOnly: true }))).toEqual({
      action: 'skip',
      reason: 'already-view-only',
    });
  });

  it('returns a decision for every status in the model, so a new status cannot fall through', () => {
    for (const status of QUOTE_STATUSES) {
      const d = decideArchive(candidate({ status }));
      expect(['archive', 'skip', 'refuse']).toContain(d.action);
    }
  });
});
