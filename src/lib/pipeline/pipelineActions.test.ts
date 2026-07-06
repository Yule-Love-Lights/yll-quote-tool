// src/lib/pipeline/pipelineActions.test.ts
import { describe, it, expect } from 'vitest';
import { pipelineActions, type PipelineRecord } from './pipelineActions';

const base: PipelineRecord = { quoteId: 'q1', quoteStatus: 'draft', isTest: false, depositPaid: false };
const kinds = (r: PipelineRecord) => pipelineActions(r).map(a => a.kind);

describe('pipelineActions', () => {
  it('draft → send channels + mark-approved + staff-decline + details', () => {
    // A draft can be staff-approved directly — the "deliberate offline/in-person
    // close" path (ALLOWED_TRANSITIONS.draft includes 'approved'; the staff-approve
    // route accepts it). The menu must surface it so an offline-closed draft isn't
    // stuck with no approve affordance. #124: staff-decline too — a customer can
    // decline a quote before it's ever sent (recorded by staff).
    expect(kinds(base)).toEqual(['send', 'send', 'send', 'mark-approved', 'staff-decline', 'details']);
    expect(pipelineActions(base).filter(a => a.kind === 'send').map(a => (a as {channel:string}).channel))
      .toEqual(['both', 'email', 'sms']);
  });
  it('offers mark-approved from every state a direct approve is legal FROM (draft/sent/viewed)', () => {
    // Mirror quoteStatus.ts canTransition(from, 'approved') for the pre-booked path.
    for (const s of ['draft', 'sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('mark-approved');
  });
  it('sent/viewed → send + mark-approved + staff-decline + details', () => {
    for (const s of ['sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['send', 'send', 'send', 'mark-approved', 'staff-decline', 'details']);
  });
  it('changes_requested → resend + staff-decline + details', () => {
    expect(kinds({ ...base, quoteStatus: 'changes_requested' })).toEqual(['send', 'send', 'send', 'staff-decline', 'details']);
  });
  it('approved (unbooked) → convert-to-job + staff-decline + details', () => {
    // #124: an approved-but-not-booked quote (no deposit) can still be declined —
    // the customer backed out before paying. Money-safe: approved ⇒ deposit unpaid.
    expect(kinds({ ...base, quoteStatus: 'approved' })).toEqual(['convert-to-job', 'staff-decline', 'details']);
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
  it('declined/cancelled/lost → rebook + details (revive a dead quote, #116)', () => {
    for (const s of ['declined', 'cancelled', 'lost'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['rebook', 'details']);
  });
  it('offers rebook only from the terminal states (declined/cancelled/lost), never from a live one', () => {
    for (const s of ['declined', 'cancelled', 'lost'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('rebook');
    for (const s of ['draft', 'sent', 'viewed', 'changes_requested', 'approved', 'booked'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('rebook');
  });
  it('offers staff-decline exactly from the states a decline is legal FROM (#124: draft/sent/viewed/approved/changes_requested)', () => {
    // Mirror quoteStatus.ts canTransition(from, "declined") = {draft, sent, viewed,
    // approved, changes_requested}. NOT from booked (paid → cancel only) or terminals.
    for (const s of ['draft', 'sent', 'viewed', 'approved', 'changes_requested'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('staff-decline');
    for (const s of ['booked', 'declined', 'cancelled', 'lost'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('staff-decline');
  });
  it('staff-decline carries a Mark-declined label', () => {
    const a = pipelineActions({ ...base, quoteStatus: 'sent' }).find(x => x.kind === 'staff-decline');
    expect(a).toMatchObject({ kind: 'staff-decline', label: 'Mark declined' });
  });
  it('details href points at the quote detail page', () => {
    const d = pipelineActions(base).find(a => a.kind === 'details');
    expect(d).toMatchObject({ kind: 'details', href: '/admin/quotes/q1' });
  });
});
