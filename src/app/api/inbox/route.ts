// Open-items feed for the /inbox UI poll (#58). Operator-gated. The client list
// component fetches this every ~25s to stay fresh without realtime. Reads through
// the service-role client (the rows are server-only; the browser never gets a
// Supabase client here).

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { listOpenItems } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  const res = await listOpenItems();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  return NextResponse.json({ items: res.items });
}
