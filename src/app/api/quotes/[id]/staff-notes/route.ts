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

  const notes = await listStaffNotes(context.id);
  if (!notes) {
    return NextResponse.json({ error: 'Failed to load staff notes' }, { status: 500 });
  }
  return NextResponse.json(
    { notes },
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
