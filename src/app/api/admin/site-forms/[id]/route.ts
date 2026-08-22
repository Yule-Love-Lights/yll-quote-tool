// Staff actions on a single non-lead submission (#195 follow-ups).
//
// POST /api/admin/site-forms/<id>
//   { action: 'handled' }   → mark it actioned (who + when)
//   { action: 'unhandled' } → put it back in the queue
//   { action: 'retry' }     → re-drive the GHL contact sync now, rather than
//                             waiting for the cron
//
// requireAdmin() like the rest of /api/admin/*: these rows carry personal data,
// and 'retry' fires a GHL write.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { asSiteFormType, syncSubmissionToGhl } from '@/lib/siteForms/siteFormService';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const { id } = await ctx.params;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = body.action;

  if (action === 'handled' || action === 'unhandled') {
    const handled = action === 'handled';
    const { error } = await sb
      .from('site_submissions')
      .update({
        handled_at: handled ? new Date().toISOString() : null,
        // Who actioned it, so two staff working the same list can tell.
        handled_by: handled ? (auth.operator.email ?? auth.operator.id) : null,
      })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, handled });
  }

  if (action === 'retry') {
    const { data, error } = await sb
      .from('site_submissions')
      .select('id,form_type,email,name,phone,retry_count')
      .eq('id', id)
      .single();
    if (error || !data) return NextResponse.json({ error: 'Submission not found' }, { status: 404 });

    const formType = asSiteFormType(data.form_type);
    if (!formType) return NextResponse.json({ error: 'Unknown form type' }, { status: 400 });

    const attempt = (data.retry_count ?? 0) + 1;
    try {
      const { contactId } = await syncSubmissionToGhl({
        formType,
        email: data.email,
        name: data.name,
        phone: data.phone,
      });
      await sb
        .from('site_submissions')
        .update({
          ghl_contact_id: contactId,
          sync_status: contactId ? 'synced' : 'skipped',
          sync_error: null,
          retry_count: attempt,
          last_retried_at: new Date().toISOString(),
        })
        .eq('id', id);
      return NextResponse.json({ ok: true, contactId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await sb
        .from('site_submissions')
        .update({
          sync_status: 'error',
          sync_error: message,
          retry_count: attempt,
          last_retried_at: new Date().toISOString(),
        })
        .eq('id', id);
      // 200 with ok:false — the retry ran, it just did not succeed. The admin UI
      // shows the reason rather than a bare failure.
      return NextResponse.json({ ok: false, error: message });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
