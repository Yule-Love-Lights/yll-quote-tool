// GET /api/tasks/count — the two numbers behind the Tasks nav badge.
//
// Separate from GET /api/tasks on purpose. The nav is shared chrome on every
// operator page, so this endpoint reads no titles, no details and no operator
// ids: one small query over due_at, no auth lookups, nothing a caller could
// not already read from the full list. It also needs no actor id, because
// "everything is shared" means these counts are identical for every operator
// (GET /api/tasks needs one only to label a task "You").
//
// A task-schema problem answers 200 with zeroes and available:false rather
// than an error status. This feeds chrome on pages that have nothing to do
// with tasks; a broken badge must stay invisible instead of turning an
// unrelated screen into an error state.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { countActiveOfficeTasks } from '@/lib/officeTasks';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;

  const result = await countActiveOfficeTasks();
  const body = result.ok
    ? { open: result.counts.open, overdue: result.counts.overdue, available: true }
    : { open: 0, overdue: 0, available: false };

  const response = NextResponse.json(body);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
