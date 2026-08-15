// src/lib/pipeline/pipelineActions.test.ts
import { describe, it, expect } from 'vitest';
import { pipelineActions, type PipelineRecord } from './pipelineActions';

const base: PipelineRecord = {
  quoteId: 'q1',
  quoteStatus: 'draft',
  isTest: false,
  depositPaid: false,
  viewOnly: false,
};
const kinds = (r: PipelineRecord) => pipelineActions(r).map(a => a.kind);

describe('pipelineActions', () => {
  it('draft → send channels + mark-sent + mark-approved + staff-decline + mark-abandoned + details', () => {
    // A draft can be staff-approved directly — the "deliberate offline/in-person
    // close" path (ALLOWED_TRANSITIONS.draft includes 'approved'; the staff-approve
    // route accepts it). The menu must surface it so an offline-closed draft isn't
    // stuck with no approve affordance. #124: staff-decline too — a customer can
    // decline a quote before it's ever sent (recorded by staff). #182: mark-sent —
    // a quote delivered outside the tool (canTransition('draft','sent') is legal).
    // #235: mark-abandoned — a draft that just went cold.
    expect(kinds(base)).toEqual([
      'send', 'send', 'send', 'mark-sent', 'mark-approved', 'staff-decline', 'mark-abandoned', 'details',
    ]);
    expect(pipelineActions(base).filter(a => a.kind === 'send').map(a => (a as {channel:string}).channel))
      .toEqual(['both', 'email', 'sms']);
  });
  it('offers mark-approved from every state a direct approve is legal FROM (draft/sent/viewed)', () => {
    // Mirror quoteStatus.ts canTransition(from, 'approved') for the pre-booked path.
    for (const s of ['draft', 'sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('mark-approved');
  });
  it('sent/viewed → send + mark-approved + staff-decline + mark-abandoned + details', () => {
    for (const s of ['sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual([
        'send', 'send', 'send', 'mark-approved', 'staff-decline', 'mark-abandoned', 'details',
      ]);
  });
  it('changes_requested → resend + staff-decline + mark-abandoned + details', () => {
    expect(kinds({ ...base, quoteStatus: 'changes_requested' })).toEqual([
      'send', 'send', 'send', 'staff-decline', 'mark-abandoned', 'details',
    ]);
  });
  it('approved (unbooked) → convert-to-job + staff-decline + details (NO mark-abandoned — not a legal transition)', () => {
    // #124: an approved-but-not-booked quote (no deposit) can still be declined —
    // the customer backed out before paying. Money-safe: approved ⇒ deposit unpaid.
    // canTransition('approved','abandoned') is NOT legal — approved never abandons.
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
  it('declined/abandoned → send channels + rebook + details (revive in place OR clone fresh, #116)', () => {
    // #116 re-send half: declined/abandoned get the same three send descriptors as
    // any other pre-terminal status (Send route treats declined/abandoned as a
    // revive — re-open the SAME quote to 'sent') PLUS rebook (clone a new
    // draft) — the operator's choice.
    for (const s of ['declined', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toEqual(['send', 'send', 'send', 'rebook', 'details']);
  });
  it('cancelled → rebook + details ONLY (no revive — post-booking, refunds are manual)', () => {
    // Cancelled means a deposit was taken and the job cancelled; re-sending
    // the same quote would paper over a refund conversation. Rebook-only.
    expect(kinds({ ...base, quoteStatus: 'cancelled' })).toEqual(['rebook', 'details']);
  });
  it('offers rebook only from the terminal states (declined/cancelled/abandoned), never from a live one', () => {
    for (const s of ['declined', 'cancelled', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('rebook');
    for (const s of ['draft', 'sent', 'viewed', 'changes_requested', 'approved', 'booked'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('rebook');
  });
  it('offers send (revive) from declined/abandoned but NOT cancelled', () => {
    for (const s of ['declined', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('send');
    expect(kinds({ ...base, quoteStatus: 'cancelled' })).not.toContain('send');
  });
  it('offers staff-decline exactly from the states a decline is legal FROM (#124: draft/sent/viewed/approved/changes_requested)', () => {
    // Mirror quoteStatus.ts canTransition(from, "declined") = {draft, sent, viewed,
    // approved, changes_requested}. NOT from booked (paid → cancel only) or terminals.
    for (const s of ['draft', 'sent', 'viewed', 'approved', 'changes_requested'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('staff-decline');
    for (const s of ['booked', 'declined', 'cancelled', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('staff-decline');
  });
  it('#235: offers mark-abandoned exactly from the states an abandon is legal FROM (draft/sent/viewed/changes_requested)', () => {
    // Mirror quoteStatus.ts canTransition(from, "abandoned") = {draft, sent, viewed,
    // changes_requested}. NOT from approved/booked (money already moving) or terminals.
    for (const s of ['draft', 'sent', 'viewed', 'changes_requested'] as const)
      expect(kinds({ ...base, quoteStatus: s })).toContain('mark-abandoned');
    for (const s of ['approved', 'booked', 'declined', 'cancelled', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('mark-abandoned');
  });
  it('#182: offers mark-sent ONLY from draft — every other status already has quote_sent_at set or is non-transitionable to sent', () => {
    expect(kinds(base)).toContain('mark-sent');
    for (const s of ['sent', 'viewed', 'changes_requested', 'approved', 'booked', 'declined', 'cancelled', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s })).not.toContain('mark-sent');
  });

  it('staff-decline carries a Mark-declined label', () => {
    const a = pipelineActions({ ...base, quoteStatus: 'sent' }).find(x => x.kind === 'staff-decline');
    expect(a).toMatchObject({ kind: 'staff-decline', label: 'Mark declined' });
  });
  it('mark-abandoned carries a Mark-abandoned label', () => {
    const a = pipelineActions({ ...base, quoteStatus: 'sent' }).find(x => x.kind === 'mark-abandoned');
    expect(a).toMatchObject({ kind: 'mark-abandoned', label: 'Mark abandoned' });
  });
  it('details href points at the quote detail page', () => {
    const d = pipelineActions(base).find(a => a.kind === 'details');
    expect(d).toMatchObject({ kind: 'details', href: '/admin/quotes/q1' });
  });
});

describe('pipelineActions — view-only (#176)', () => {
  it('suppresses send/mark-sent/mark-approved/staff-decline/mark-abandoned on a view-only draft, leaving only details', () => {
    expect(kinds({ ...base, viewOnly: true })).toEqual(['details']);
  });
  it('suppresses send + staff-decline + mark-abandoned on a view-only sent/viewed quote', () => {
    for (const s of ['sent', 'viewed'] as const)
      expect(kinds({ ...base, quoteStatus: s, viewOnly: true })).toEqual(['details']);
  });
  it('suppresses staff-decline on a view-only approved quote, leaving convert-to-job', () => {
    // convert-to-job isn't a customer-facing action the view_only guard blocks
    // (it's how staff books a deposit already taken outside the portal).
    expect(kinds({ ...base, quoteStatus: 'approved', viewOnly: true })).toEqual(['convert-to-job', 'details']);
  });
  it('does not suppress the booked-job housekeeping actions on a view-only booked quote', () => {
    expect(
      kinds({
        ...base,
        quoteStatus: 'booked',
        depositPaid: true,
        job: { id: 'j', status: 'to_schedule' },
        viewOnly: true,
      }),
    ).toEqual(['mark-complete', 'amend', 'cancel', 'details']);
  });
  it('does not suppress rebook on a view-only terminal quote', () => {
    for (const s of ['declined', 'cancelled', 'abandoned'] as const)
      expect(kinds({ ...base, quoteStatus: s, viewOnly: true })).toEqual(['rebook', 'details']);
  });
});
