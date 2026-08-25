import { NextRequest, NextResponse } from 'next/server';
import { getOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  STAFF_NOTE_MAX_LENGTH,
  appendStaffNote,
  listStaffNotes,
  quoteExistsForStaffNotes,
} from '@/lib/staffNotes';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Row 373: exactly the shape Postgres hands back for a `timestamptz` through
// PostgREST — date, time, fractional seconds, and a Z or +/-HH:MM offset.
// Deliberately narrow: this value is interpolated into a filter string, so the
// question is not "can Date parse it" but "is it only the characters a
// timestamp can contain".
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

type StaffNotesContext =
  | { ok: true; id: string; operator: NonNullable<Awaited<ReturnType<typeof getOperator>>> }
  | { ok: false; response: NextResponse };

async function contextForStaffNotes(params: Promise<{ id: string }>): Promise<StaffNotesContext> {
  const operator = await getOperator();
  if (!operator) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isSupabaseServiceConfigured()) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 }),
    };
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid quote id' }, { status: 400 }) };
  }
  const exists = await quoteExistsForStaffNotes(id);
  if (exists === null) {
    return { ok: false, response: NextResponse.json({ error: 'Failed to load quote' }, { status: 500 }) };
  }
  if (!exists) {
    return { ok: false, response: NextResponse.json({ error: 'Quote not found' }, { status: 404 }) };
  }
  return { ok: true, id, operator };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = await contextForStaffNotes(params);
  if (!context.ok) return context.response;

  // Row 373: keyset cursor for the NEXT page.
  //
  // VALIDATED HERE, not trusted downstream (technical lens MED): listStaffNotes
  // interpolates both halves into a PostgREST `.or()` filter string, and
  // postgrest-js does no escaping of its own. An id like `X",body.neq."y` would
  // close the quoting and append a condition of the attacker's choosing. The
  // `quote_id` scope is a separate AND'd parameter so it could not reach
  // another quote's notes, and the route already requires an operator session —
  // but a filter an outsider can shape is not a thing to leave standing. Same
  // UUID_RE this route already applies to the quote id, plus a strict ISO-8601
  // check on the timestamp; anything else is a 400, not a silent first page.
  //
  // Both halves must be present — a lone timestamp cannot separate two notes
  // written in the same instant — so a partial cursor is no cursor.
  const url = new URL(_req.url);
  const beforeCreatedAt = url.searchParams.get('beforeCreatedAt');
  const beforeId = url.searchParams.get('beforeId');
  if (beforeCreatedAt || beforeId) {
    if (!beforeCreatedAt || !beforeId || !UUID_RE.test(beforeId) || !ISO_TIMESTAMP_RE.test(beforeCreatedAt)) {
      return NextResponse.json({ error: 'Invalid page cursor' }, { status: 400 });
    }
  }
  const before =
    beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : null;

  const page = await listStaffNotes(context.id, before);
  if (!page) {
    return NextResponse.json({ error: 'Failed to load staff notes' }, { status: 500 });
  }
  return NextResponse.json(
    { notes: page.notes, hasMore: page.hasMore },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = await contextForStaffNotes(params);
  if (!context.ok) return context.response;

  let payload: { body?: unknown; clientRequestId?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    payload = {};
  }
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body || body.length > STAFF_NOTE_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Note must be between 1 and ${STAFF_NOTE_MAX_LENGTH} characters` },
      { status: 400 },
    );
  }
  if (typeof payload.clientRequestId !== 'string' || !UUID_RE.test(payload.clientRequestId)) {
    return NextResponse.json({ error: 'A valid clientRequestId is required' }, { status: 400 });
  }

  const result = await appendStaffNote({
    quoteId: context.id,
    body,
    createdBy: context.operator.id,
    createdByLabel: context.operator.name ?? context.operator.email ?? 'Staff',
    clientRequestId: payload.clientRequestId,
  });
  if (result.kind === 'created' || result.kind === 'duplicate') {
    return NextResponse.json(
      { note: result.note, duplicate: result.kind === 'duplicate' },
      { status: result.kind === 'created' ? 201 : 200 },
    );
  }
  if (result.kind === 'not-found') return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  if (result.kind === 'conflict') {
    return NextResponse.json({ error: 'That request id was already used for another note' }, { status: 409 });
  }
  return NextResponse.json({ error: 'Failed to save staff note' }, { status: 500 });
}
