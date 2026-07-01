// src/lib/pipeline/pipelineActions.test.ts
import { describe, it, expect } from 'vitest';
import { pipelineActions, type PipelineRecord } from './pipelineActions';

const base: PipelineRecord = { quoteId: 'q1', quoteStatus: 'draft', isTest: false, depositPaid: false };
const kinds = (r: PipelineRecord) => pipelineActions(r).map(a => a.kind);

describe('pipelineActions', () => {
  it('draft → send channels + details only', () => {
    expect(kinds(base)).toEqual(['send', 'send', 'send', 'details']);
    expect(pipelineActions(base).filter(a => a.kind === 'send').map(a => (a as {channel:string}).channel))
      .toEqual(['both', 'email', 'sms']);
  });
  it('sent/viewed → send + mark-approved + details', () => {
    for (const s of ['sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['send', 'send', 'send', 'mark-approved', 'details']);
  });
  it('changes_requested → resend + details', () => {
    expect(kinds({ ...base, quoteStatus: 'changes_requested' })).toEqual(['send', 'send', 'send', 'details']);
  });
  it('approved (unbooked) → convert-to-job + details', () => {
    expect(kinds({ ...base, quoteStatus: 'approved' })).toEqual(['convert-to-job', 'details']);
  });
  it('booked but job is null (auto-create failed at deposit) → create-job + details', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: null }))
      .toEqual(['create-job', 'details']);
  });
  it('booked WITH a job does not offer create-job', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'to_schedule' } }))
      .not.toContain('create-job');
  });
  it('booked + job to_schedule → mark-complete, amend, cancel, details', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'to_schedule' } }))
      .toEqual(['mark-complete', 'amend', 'cancel', 'details']);
  });
  it('booked + requires_invoicing + unpaid invoice → collect-payment, close, amend, cancel, details', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true,
      job: { id: 'j', status: 'requires_invoicing' }, invoice: { id: 'i', status: 'awaiting_payment', balance: 500 } }))
      .toEqual(['collect-payment', 'close', 'amend', 'cancel', 'details']);
  });
  it('booked + requires_invoicing + paid invoice → close, amend, cancel, details (no collect)', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true,
      job: { id: 'j', status: 'requires_invoicing' }, invoice: { id: 'i', status: 'paid', balance: 0 } }))
      .toEqual(['close', 'amend', 'cancel', 'details']);
  });
  it('job done or cancelled → details only', () => {
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'done' } })).toEqual(['details']);
    expect(kinds({ ...base, quoteStatus: 'booked', depositPaid: true, job: { id: 'j', status: 'cancelled' } })).toEqual(['details']);
  });
  it('declined/cancelled/lost → details only', () => {
    for (const s of ['declined', 'cancelled', 'lost'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['details']);
  });
  it('details href points at the quote detail page', () => {
    const d = pipelineActions(base).find(a => a.kind === 'details');
    expect(d).toMatchObject({ kind: 'details', href: '/admin/quotes/q1' });
  });
});
