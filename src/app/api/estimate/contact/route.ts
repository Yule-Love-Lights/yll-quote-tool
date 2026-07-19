// Customer self-serve estimate — contact capture (Phase A, ledger self-serve).
//
// POST /api/estimate/contact
// Body: { quoteId?, name, email, phone, address?, consent?, partial?,
//         company?, rangeLabel? }
//
// Two modes, one endpoint:
//   * partial:true  — progressive / abandonment save. Fired as the customer
//                     types (blur/page-leave). At least one contact handle is
//                     required. Enriches the draft quote with whatever's typed
//                     and syncs a no-drip 'partial-lead' contact to GHL. NEVER
//                     enters the SMS drips (no consent yet). Always { ok:true }.
//   * final (default) — the customer submitted WITH consent. Requires name +
//                     email + phone + consent:true. Runs the full christmas
//                     lead sync (contact + 'new lead' tag + opportunity at the
//                     pipeline entry stage) and links the GHL ids onto the quote.
//
// The draft quote (saved by /api/estimate) is the source of truth for the
// address + price; this route attaches WHO the customer is. GHL is best-effort —
// a sync failure is logged, never surfaced (the quote/contact is already saved).

import { NextRequest, NextResponse } from 'next/server';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { syncLeadToGhl } from '@/lib/leads/leadService';
import { syncPartialLeadToGhl } from '@/lib/leads/partialLead';
import { enrichSelfServeQuote } from '@/lib/selfServe/quote';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_MIN_DIGITS = 7;
const MAX_LEN = { name: 200, email: 320, phone: 40, address: 500, rangeLabel: 120 } as const;
const FORM_VARIANT = 'self-serve-estimate';
const LEAD_SERVICE = 'christmas' as const;

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : '';
}
function phoneDigits(v: string): number {
  const m = v.match(/\d/g);
  return m ? m.length : 0;
}

export async function POST(req: NextRequest) {
  if (!isSelfServeEstimateEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Every accepted call can trigger a GHL contact/opportunity write (and the
  // final path adds the 'new lead' tag that enrolls the number in SMS drips), so
  // cap hard per IP. Headroom for one real fill: partial-on-blur of email + phone
  // + the final submit ≈ 3 calls, plus re-edits. 15/min stays well clear of that
  // while stopping a script from mass-creating GHL leads / drip-enrolling numbers.
  const blocked = rateLimitResponse(req, { bucket: 'self-serve-contact', limit: 15, windowMs: 60_000 });
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Honeypot — answer OK, do nothing (indistinguishable to a bot).
  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const quoteId = str(body.quoteId, 64) || null;
  const name = str(body.name, MAX_LEN.name);
  const email = str(body.email, MAX_LEN.email);
  const phone = str(body.phone, MAX_LEN.phone);
  const address = str(body.address, MAX_LEN.address) || null;
  const rangeLabel = str(body.rangeLabel, MAX_LEN.rangeLabel) || null;
  const isPartial = body.partial === true;

  const hasEmail = !!email && EMAIL_RE.test(email);
  const hasPhone = phoneDigits(phone) >= PHONE_MIN_DIGITS;

  // ── Progressive / abandonment capture ─────────────────────────────────────
  if (isPartial) {
    // A lone name (or junk) is not a lead — no-op OK, same as /api/leads/partial.
    if (!hasEmail && !hasPhone) {
      return NextResponse.json({ ok: true, skipped: 'no-contact' }, { status: 200 });
    }
    let ghlContactId: string | null = null;
    if (isHighLevelConfigured()) {
      try {
        const r = await syncPartialLeadToGhl({
          name,
          email: hasEmail ? email : null,
          phone: hasPhone ? phone : null,
          address,
          source: 'Self-Serve Estimate (partial)',
        });
        ghlContactId = r.ghlContactId ?? null;
      } catch (err) {
        console.error('[api/estimate/contact] partial GHL sync failed (continuing):', err instanceof Error ? err.name : 'error');
      }
    }
    if (quoteId) {
      await enrichSelfServeQuote(quoteId, { name, email: hasEmail ? email : null, phone: hasPhone ? phone : null }, { contactId: ghlContactId });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // ── Final submission (consent required) ───────────────────────────────────
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (!hasEmail) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  if (!hasPhone) return NextResponse.json({ error: 'A valid phone is required' }, { status: 400 });
  // Strictly true — the christmas sync adds the 'new lead' tag, which enrolls the
  // contact in SMS drips; texting a non-consenter is never acceptable.
  if (body.consent !== true) {
    return NextResponse.json({ error: 'consent is required — check the box to submit' }, { status: 400 });
  }

  let ghlContactId: string | null = null;
  let ghlOpportunityId: string | null = null;
  if (isHighLevelConfigured()) {
    try {
      const notes = rangeLabel ? `Self-serve estimate: ${rangeLabel}` : 'Self-serve estimate';
      const r = await syncLeadToGhl({
        name,
        email,
        phone,
        address,
        service: LEAD_SERVICE,
        notes,
        formVariant: FORM_VARIANT,
      });
      ghlContactId = r.ghlContactId ?? null;
      ghlOpportunityId = r.ghlOpportunityId ?? null;
    } catch (err) {
      // Best-effort: the contact still lands on the quote below; a GHL outage
      // must not fail the customer's submission.
      console.error('[api/estimate/contact] christmas GHL sync failed (continuing):', err instanceof Error ? err.name : 'error');
    }
  }

  if (quoteId) {
    await enrichSelfServeQuote(quoteId, { name, email, phone }, { contactId: ghlContactId, opportunityId: ghlOpportunityId });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
