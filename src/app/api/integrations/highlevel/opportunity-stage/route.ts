// HighLevel opportunity-stage webhook: archive the quote when the deal dies
// (S75, Naldo 2026-08-29).
//
// POST /api/integrations/highlevel/opportunity-stage
// Header: x-dashboard-secret: <DASHBOARD_WEBHOOK_SECRET>   (the same shared
//         secret as the existing GHL "Customer Replied" webhook, so setup in
//         HighLevel is one value, not two)
//
// Body. Either form is accepted, because a GHL workflow can be built either way
// and both are a couple of clicks to wire:
//   { "contactId": "...", "outcome": "declined" | "abandoned" }
//   { "contactId": "...", "pipelineStageId": "..." }
// Common GHL merge-field spellings for the contact are also read (contact_id,
// id, contact.id), so a workflow built from the stock template still works.
//
// What it does: every LIVE quote linked to that contact goes terminal (declined
// or abandoned). That status ALONE is the archive Naldo asked for: the customer
// keeps their portal link and can still open it, look at the design, and play
// with the colours, while /approve, /pay, /decline and /request-changes each
// independently 409 a terminal quote, and StickyBottomBar swaps the approve
// controls for a browse strip with a "want to reopen this?" ask (ledger row
// 236). Staff revive it with the existing revive on /send (canRevive covers
// both terminal statuses).
//
// It deliberately does NOT also set view_only, which the first cut did. The
// premerge customer lens caught why: StickyBottomBar checks view_only BEFORE
// isTerminalBrowseStatus, so setting both would have shown every archived
// customer the unrelated #176 "Just browsing, text us your favourite look"
// copy and made the reopen-ask button unreachable for exactly the population
// most likely to want it. The terminal status on its own gives the intended
// behaviour and the better screen.
//
// What it will NOT do, by Naldo's explicit rule: touch a quote with money on
// it. An approved, booked, or deposit-paid quote is REFUSED and reported, never
// archived, because this fires on a drag in another system and a misclick must
// not relabel work the customer already said yes to. Refusals are pinged to
// Telegram rather than swallowed.
//
// Perimeter: listed in operatorGate's PUBLIC_API_EXACT. A GHL request carries
// no operator session, so without that entry the proxy 401s it before this
// route's own secret check ever runs (the recurring S42/S44/S47 defect).

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { deriveStatus, isQuoteStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import {
  asArchiveOutcome,
  outcomeForStageId,
  decideArchive,
  serviceTypesForPipeline,
  quoteIsInScope,
  ARCHIVABLE_FROM,
  type ArchiveOutcome,
} from '@/lib/integrations/ghlQuoteArchive';

export const runtime = 'nodejs';

type QuoteRow = {
  id: string;
  quote_number: number | null;
  customer_name: string | null;
  status: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  view_only: boolean;
  approval_snapshot: Record<string, unknown> | null;
  // Scoping (premerge technical + admin lenses, converged): which pipeline this
  // quote's card lives in, so a drag in one pipeline cannot archive a live
  // quote in another.
  service_type: string | null;
  legacy_rebook: boolean;
};

/** Pull the contact id out of whichever spelling the workflow happens to send. */
export function readContactId(body: Record<string, unknown>): string | null {
  for (const key of ['contactId', 'contact_id', 'id']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const contact = body.contact;
  if (contact && typeof contact === 'object') {
    const v = (contact as Record<string, unknown>).id;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The pipeline stage id, same tolerance. */
export function readStageId(body: Record<string, unknown>): string | null {
  for (const key of ['pipelineStageId', 'pipeline_stage_id', 'stageId', 'stage_id']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const opp = body.opportunity;
  if (opp && typeof opp === 'object') {
    const o = opp as Record<string, unknown>;
    for (const key of ['pipelineStageId', 'pipeline_stage_id']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** The pipeline id, so the archive can be scoped to the deal that moved. */
export function readPipelineId(body: Record<string, unknown>): string | null {
  for (const key of ['pipelineId', 'pipeline_id']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const opp = body.opportunity;
  if (opp && typeof opp === 'object') {
    const o = opp as Record<string, unknown>;
    for (const key of ['pipelineId', 'pipeline_id']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.headers.get('x-dashboard-secret') ?? undefined, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rl = rateLimitResponse(req, { bucket: 'ghl-opportunity-stage', limit: 120, windowMs: 60_000 });
  if (rl) return rl;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'bad-body' }, { status: 400 });
  }

  const contactId = readContactId(body);
  if (!contactId) {
    return NextResponse.json({ error: 'No contact id in the payload', code: 'no-contact' }, { status: 400 });
  }

  // An explicitly-named outcome wins over the stage id: a workflow that states
  // what it means should not be second-guessed by a stage-id lookup.
  const outcome: ArchiveOutcome | null =
    asArchiveOutcome(body.outcome) ?? outcomeForStageId(readStageId(body));

  // Not an archive stage. 200 on purpose: GHL retries a non-2xx, and an
  // ordinary pipeline move is a correct, expected no-op, not a failure.
  if (!outcome) {
    return NextResponse.json({ ok: true, ignored: 'not-an-archive-stage' });
  }

  // Scope the archive to the pipeline the drag happened in, when the payload
  // named one. Null means the payload carried no pipeline (the explicit-outcome
  // form does not carry one), in which case every live quote for the contact is
  // in scope, exactly as before — reported as `scoped` in the response so a
  // wide sweep is never silent.
  const scope = serviceTypesForPipeline(readPipelineId(body));

  const sb = getSupabaseServiceClient()!;
  const { data: quotes, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, quote_number, customer_name, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, view_only, approval_snapshot, service_type, legacy_rebook',
    )
    .eq('highlevel_contact_id', contactId)
    .returns<QuoteRow[]>();

  if (fetchErr) {
    console.error('[api/integrations/highlevel/opportunity-stage] quote lookup failed:', fetchErr.message);
    return NextResponse.json({ error: 'Quote lookup failed' }, { status: 500 });
  }
  if (!quotes || quotes.length === 0) {
    return NextResponse.json({
      ok: true,
      outcome,
      scoped: !!scope,
      matched: 0,
      archived: 0,
      skipped: [],
      refused: [],
    });
  }

  const at = new Date().toISOString();
  const archived: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const refused: {
    id: string;
    quoteNumber: number | null;
    name: string | null;
    reason: string;
    status: QuoteStatus;
  }[] = [];

  for (const q of quotes) {
    if (!quoteIsInScope({ serviceType: q.service_type, legacyRebook: q.legacy_rebook }, scope)) {
      skipped.push({ id: q.id, reason: 'other-pipeline' });
      continue;
    }
    const typed = isQuoteStatus(q.status) ? q.status : null;
    const status = deriveStatus({ ...q, status: typed });
    const decision = decideArchive({
      status,
      customerApprovedAt: q.customer_approved_at,
      depositPaidAt: q.deposit_paid_at,
      viewOnly: q.view_only,
    });

    if (decision.action === 'skip') {
      skipped.push({ id: q.id, reason: decision.reason });
      continue;
    }
    if (decision.action === 'refuse') {
      refused.push({
        id: q.id,
        quoteNumber: q.quote_number,
        name: q.customer_name,
        reason: decision.reason,
        status,
      });
      continue;
    }

    // Audit marker, mirroring staff-abandon's approval_snapshot.staffAbandoned.
    // This is the "what moved it" record: nothing is deleted, and this says
    // exactly what archived the quote, when, and what it was before, so a
    // mistake is findable and undoable.
    const snapshot: Record<string, unknown> = {
      ...(q.approval_snapshot ?? {}),
      ghlArchived: {
        outcome,
        at,
        contactId,
        source: 'ghl-opportunity-stage-webhook',
        priorStatus: status,
      },
    };

    // Guarded write. The money columns are re-checked IN the write, not only in
    // decideArchive above, so an approval or deposit that lands between the read
    // and here loses the race instead of being archived on stale state.
    // view_only is pinned false as a read-side guard (NOT NULL, so a plain .eq
    // is safe), mirroring staff-abandon's own TOCTOU guard: a quote staff have
    // parked browse-only is left to them.
    //
    // The status is the ONLY thing written. Setting view_only as well was the
    // first cut and was wrong — see the archive doc at the top of this file.
    //
    // Premerge technical lens (MED): the STATUS itself is re-checked here too,
    // mirroring staff-abandon's `abandonableFilter`. Without it, a quote a
    // customer declined in the read-write gap could be flipped declined ->
    // abandoned, which the transition table forbids. Legacy rows carry a null
    // status (deriveStatus reconstructs it from timestamps), so null is
    // explicitly allowed, exactly as the sibling routes allow it.
    const archivableFilter = `status.in.(${ARCHIVABLE_FROM.join(',')}),status.is.null`;
    const { data: claimed, error: updErr } = await sb
      .from('quotes')
      .update({ status: outcome satisfies QuoteStatus, approval_snapshot: snapshot })
      .eq('id', q.id)
      .eq('view_only', false)
      .or(archivableFilter)
      .is('customer_approved_at', null)
      .is('deposit_paid_at', null)
      .select('id');

    if (updErr) {
      console.error(
        '[api/integrations/highlevel/opportunity-stage] archive write failed:',
        q.id,
        updErr.message,
      );
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Lost the race: approved, paid, or parked view-only between the read and
      // the write. Report it rather than retrying into it.
      refused.push({
        id: q.id,
        quoteNumber: q.quote_number,
        name: q.customer_name,
        reason: 'lost-race',
        status,
      });
      continue;
    }
    archived.push(q.id);
  }

  // A refusal means HighLevel and the quote tool now disagree about a customer
  // who has money on the books. Staff need to see that, so it is a ping, not a
  // log line. Best-effort: notifyTelegramAudience never throws.
  if (refused.length) {
    // Premerge technical lens (LOW): say WHY per row rather than asserting
    // money for all of them — a lost-race refusal is a different story from an
    // approved quote, and a message that overstates its own cause is the kind
    // staff learn to ignore.
    const why: Record<string, string> = {
      'has-money': 'already approved or paid',
      'lost-race': 'changed while we were writing',
      'illegal-transition': 'not in a state we can close',
    };
    const lines = refused.map(
      (r) =>
        `- ${r.name || 'Unknown'} (quote #${r.quoteNumber ?? '?'}, ${r.status}): ${why[r.reason] ?? r.reason}`,
    );
    await notifyTelegramAudience(
      'leads',
      [
        `HighLevel moved a contact to ${outcome}, but ${refused.length} quote(s) were left alone:`,
        ...lines,
        'Nothing changed in the quote tool. Check whether the CRM move was right.',
      ].join('\n'),
    );
  }

  return NextResponse.json({
    ok: true,
    outcome,
    scoped: !!scope,
    matched: quotes.length,
    archived: archived.length,
    skipped,
    refused,
  });
}
