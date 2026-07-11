// Referral landing page submit (ledger #41). Public — no operator auth, rate
// limited, re-validates the code server-side (never trusts a client-supplied
// referrer). Creates three things, each best-effort except the code check:
//   (a) a GHL contact tagged 'referral' (fail-open — GHL down/unconfigured
//       must never block confirming to the customer we got their info)
//   (b) an inbox item so the team follows up (source 'quotetool')
//   (c) the pending referral row (source 'link') — the accrual data PR 2 reads
//
// POST /api/referrals/submit
//   Body: { code, name, phone, address, email? }
//   Response: { ok: true, referralId } | { error }

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getReferralByCode, createPendingReferral, hasRecentPendingLinkReferral } from '@/lib/referrals';
import { createContact, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { ingestTouch } from '@/lib/dashboard/inbox/store';
import { normalizePhone } from '@/lib/customers';

export const runtime = 'nodejs';

const MAX_CODE_LEN = 16;
const MAX_FIELD_LEN = 200;
const MAX_ADDRESS_LEN = 300;

function cleanStr(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

export async function POST(req: NextRequest) {
  const rl = rateLimitResponse(req, { bucket: 'referral-submit', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { code, name, phone, address, email } = body as Record<string, unknown>;

  const cleanCode = cleanStr(code, MAX_CODE_LEN);
  if (!cleanCode) return NextResponse.json({ error: 'Missing referral code' }, { status: 400 });

  // Server-side re-validation — never trust a client-supplied referrer.
  const referrer = await getReferralByCode(cleanCode);
  if (!referrer) {
    return NextResponse.json({ error: 'Invalid or expired referral link' }, { status: 404 });
  }

  const cleanName = cleanStr(name, MAX_FIELD_LEN);
  const cleanPhone = cleanStr(phone, MAX_FIELD_LEN);
  const cleanAddress = cleanStr(address, MAX_ADDRESS_LEN);
  const cleanEmail = cleanStr(email, MAX_FIELD_LEN);
  if (!cleanName || !cleanPhone || !cleanAddress) {
    return NextResponse.json({ error: 'Name, phone, and address are required' }, { status: 400 });
  }
  const normalizedPhone = normalizePhone(cleanPhone);

  // #41 adversarial-review LOW fix: skip (a) and (c) below when this exact
  // phone already has a pending 'link' referral for this SAME referrer,
  // recently (a refreshed/resubmitted form, or a double-post) — no need for
  // a second GHL contact or a second pending row for the same lead. Fails
  // OPEN: a lookup hiccup here must never block a genuine new lead.
  let isDuplicateSubmission = false;
  try {
    if (normalizedPhone) {
      isDuplicateSubmission = await hasRecentPendingLinkReferral(referrer.customerId, normalizedPhone);
    }
  } catch (err) {
    console.error('[api/referrals/submit] duplicate check failed (proceeding as new):', err);
  }

  // (a) GHL contact — fail-open on every axis (not configured, or the call throws).
  if (!isDuplicateSubmission) {
    try {
      if (isHighLevelConfigured()) {
        await createContact({
          name: cleanName,
          phone: cleanPhone,
          email: cleanEmail ?? undefined,
          address1: cleanAddress,
          tags: ['referral'],
          source: 'referral-landing-page',
        });
      }
    } catch (err) {
      console.error('[api/referrals/submit] GHL contact create failed:', err);
    }
  }

  // (b) Inbox item so staff follow up — subject names the referrer. Best-effort:
  // ingestTouch itself resolves to {ok:false} rather than throwing, but this is
  // wrapped anyway (belt-and-suspenders, matches the rest of the app's side-
  // effect call sites) so a genuinely unexpected throw can't break the response.
  // Always runs, even on a duplicate submission — ingestTouch threads by its
  // own deterministic externalId, so a resubmission is its own concern there.
  try {
    await ingestTouch(
      {
        source: 'quotetool',
        externalId: `referral:${cleanCode}:${normalizedPhone ?? cleanName}`,
        sourceMessageId: null,
        direction: 'inbound',
        channel: null,
        lastMessageAt: new Date(),
        preview: `${cleanName} at ${cleanAddress}`,
        subject: `${referrer.name ?? 'A customer'} referred ${cleanName}`,
        identity: {
          emails: cleanEmail ? [cleanEmail] : [],
          phones: cleanPhone ? [cleanPhone] : [],
          displayName: cleanName,
        },
      },
      new Date(),
    );
  } catch (err) {
    console.error('[api/referrals/submit] inbox ingest failed:', err);
  }

  // (c) The pending referral row — source 'link'. referee_quote_id is null
  // here (no quote exists yet for this lead); see migrations/2026-07-10-
  // referrals.sql for why that's the correct, safe shape.
  const referral = isDuplicateSubmission
    ? null
    : await createPendingReferral({
        source: 'link',
        referrerCustomerId: referrer.customerId,
        refereeContactName: cleanName,
        refereeContactEmail: cleanEmail,
        refereeContactPhone: cleanPhone,
      });

  return NextResponse.json({ ok: true, referralId: referral?.id ?? null });
}
