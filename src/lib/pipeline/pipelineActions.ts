// src/lib/pipeline/pipelineActions.ts
//
// Pure status-aware action core for the operator pipeline console (#83 ops).
// A thin wrapper over the existing #83 status machines: the actions returned
// here are exactly those the canTransition tables would allow, expressed as
// UI-ready action descriptors. No IO — safe to import from server + client.
import type { QuoteStatus } from '@/lib/quoteStatus';
import type { JobStatus } from '@/lib/jobStatus';
import type { InvoiceStatus } from '@/lib/invoiceStatus';

export type PipelineRecord = {
  quoteId: string;
  quoteStatus: QuoteStatus;
  isTest: boolean;
  depositPaid: boolean;
  job?: { id: string; status: JobStatus } | null;
  invoice?: { id: string; status: InvoiceStatus; balance: number } | null;
};

export type PipelineAction =
  | { kind: 'send'; channel: 'email' | 'sms' | 'both'; label: string }
  | { kind: 'mark-approved'; label: string }
  | { kind: 'staff-decline'; label: string }
  | { kind: 'convert-to-job'; label: string }
  | { kind: 'create-job'; label: string }
  | { kind: 'mark-complete'; label: string }
  | { kind: 'collect-payment'; label: string }
  | { kind: 'close'; label: string }
  | { kind: 'amend'; label: string }
  | { kind: 'cancel'; label: string }
  | { kind: 'rebook'; label: string }
  | { kind: 'details'; label: string; href: string };

function sendActions(): PipelineAction[] {
  return [
    { kind: 'send', channel: 'both', label: 'Send (email + text)' },
    { kind: 'send', channel: 'email', label: 'Send email' },
    { kind: 'send', channel: 'sms', label: 'Send text' },
  ];
}

/**
 * Legal actions for a record's current status. A pure wrapper over the #83
 * status machines — it can only ever offer a move the canTransition tables allow.
 */
export function pipelineActions(r: PipelineRecord): PipelineAction[] {
  const a: PipelineAction[] = [];

  switch (r.quoteStatus) {
    case 'draft':
      a.push(...sendActions());
      // A draft can be staff-approved directly — the "deliberate offline/in-person
      // close" path (canTransition('draft','approved') is legal; the staff-approve
      // route accepts it). Surfaced so an offline-closed draft has an approve action.
      a.push({ kind: 'mark-approved', label: 'Mark approved' });
      // #124: a draft the customer declined before it was ever sent (phone/text).
      // Legal FROM draft per canTransition(_, 'declined'); the staff-decline route
      // guards the write on deposit_paid_at IS NULL (a draft never has one).
      a.push({ kind: 'staff-decline', label: 'Mark declined' });
      break;
    case 'sent':
    case 'viewed':
      a.push(...sendActions()); // resend
      a.push({ kind: 'mark-approved', label: 'Mark approved' });
      // Staff records a decline the customer gave outside the tool (phone/text).
      // Legal FROM sent/viewed/changes_requested per canTransition(_, 'declined').
      a.push({ kind: 'staff-decline', label: 'Mark declined' });
      break;
    case 'changes_requested':
      a.push(...sendActions()); // edit + resend
      a.push({ kind: 'staff-decline', label: 'Mark declined' });
      break;
    case 'approved':
      a.push({ kind: 'convert-to-job', label: 'Convert to job' });
      // #124: an approved-but-not-booked quote (customer approved, no deposit yet)
      // the customer then backed out of. Legal FROM approved per canTransition(_,
      // 'declined'); money-safe — approved ⇒ deposit_paid_at IS NULL (else booked),
      // and the staff-decline route re-guards on it.
      a.push({ kind: 'staff-decline', label: 'Mark declined' });
      break;
    case 'booked': {
      const job = r.job ?? null;
      const inv = r.invoice ?? null;
      // Rare recovery: booked (deposit paid) but auto job-create failed, so no
      // job exists. Offer (re)create — createJobFromQuote is idempotent, and
      // convert-to-job's already-booked branch re-runs it.
      if (!job) {
        a.push({ kind: 'create-job', label: 'Create job' });
      }
      if (job && job.status !== 'done' && job.status !== 'cancelled') {
        if (job.status === 'to_schedule' || job.status === 'scheduled' || job.status === 'installed') {
          a.push({ kind: 'mark-complete', label: 'Mark installed / complete' });
        }
        if (job.status === 'requires_invoicing') {
          if (inv && inv.status !== 'paid' && inv.status !== 'cancelled') {
            a.push({ kind: 'collect-payment', label: 'Collect payment' });
          }
          a.push({ kind: 'close', label: 'Close job / invoice' });
        }
        a.push({ kind: 'amend', label: 'Amend order' });
        a.push({ kind: 'cancel', label: 'Cancel' });
      }
      break;
    }
    case 'declined':
    case 'lost':
      // #116 (re-send half): revive the SAME quote — Send re-opens it to
      // 'sent' (re-stamp, re-message, re-advance the GHL card), guarded in
      // the /send route by canRevive() + a deposit_paid_at money check. PLUS
      // rebook, which clones a fresh draft instead and leaves this quote
      // untouched — the operator picks whichever fits.
      a.push(...sendActions()); // revive
      a.push({ kind: 'rebook', label: 'Rebook (new draft)' });
      break;
    case 'cancelled':
      // #116: cancelled is post-booking (a deposit was taken, then the job
      // was cancelled) — a refund is a manual money conversation, so a quiet
      // re-send is deliberately NOT offered here. Rebook-only: clone a fresh
      // draft into a new booking, the original stays intact.
      a.push({ kind: 'rebook', label: 'Rebook (new draft)' });
      break;
  }

  a.push({ kind: 'details', label: 'Details', href: `/admin/quotes/${r.quoteId}` });
  return a;
}
