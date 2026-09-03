// The suppressed-senders panel's API (S75, Naldo 2026-08-29). Operator-gated.
//
// GET    → the live list, each entry with whatever history exists and whether
//          the address belongs to a real customer.
// DELETE → un-suppress one address, so its messages notify again.
//
// This exists because marking an inbox item "Not a lead" silently adds that
// sender to `dashboard.suppressedSenders` forever, and nothing in the app ever
// showed you the list. Measured on prod the day this shipped: 152 entries, 5 of
// them booked customers.

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getSuppressedSenders,
  removeSuppressedSenders,
  normalizeSuppressionValues,
} from '@/lib/dashboard/inbox/suppression';
import { listSuppressedSenders } from '@/lib/dashboard/inbox/suppressionAudit';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const entries = await listSuppressedSenders(await getSuppressedSenders());
  return NextResponse.json({ ok: true, entries });
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-unsuppress', limit: 60, windowMs: 60_000 });
  if (rl) return rl;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { value } = body as { value?: unknown };
  if (typeof value !== 'string' || !value.trim()) {
    return NextResponse.json({ error: 'A sender value is required' }, { status: 400 });
  }

  // Normalize the SAME way the list itself does before comparing. A phone is
  // stored E.164 and an email lowercased, so a raw lowercase of whatever the
  // panel sent would miss every phone entry.
  const [normalized] = normalizeSuppressionValues([value]);
  if (!normalized) {
    return NextResponse.json(
      { error: 'That is not a usable email or phone number', code: 'unparseable' },
      { status: 400 },
    );
  }

  // Refuse an address that is not actually on the list, rather than reporting a
  // cheerful success for a no-op. A stale panel is exactly how someone comes to
  // believe they un-suppressed a customer they did not.
  const current = await getSuppressedSenders();
  if (!current.has(normalized)) {
    return NextResponse.json(
      { error: 'That sender is not on the suppression list', code: 'not-suppressed' },
      { status: 409 },
    );
  }

  const operator = await getOperator();
  await removeSuppressedSenders([normalized], {
    actor: operator?.id ?? null,
    note: 'removed from the suppressed senders panel',
  });

  return NextResponse.json({ ok: true, removed: normalized });
}
