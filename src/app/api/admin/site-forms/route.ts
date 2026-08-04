// GET /api/admin/site-forms — operator view of non-lead website submissions
// (#195): newsletter signups, job and intern applications, Light Up For Hope
// nominations.
//
// requireAdmin() like the rest of /api/admin/*: these rows carry personal data,
// and a nomination carries a THIRD party's home address and contact details,
// which is the most sensitive data on this surface. A resume download link is
// minted here as a short-lived signed URL — the storage bucket itself is
// private and never publicly readable.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { SITE_FORM_TYPES } from '@/lib/siteForms/siteFormService';

export const runtime = 'nodejs';

const LIST_COLUMNS =
  'id,created_at,form_type,form_variant,name,email,phone,payload,resume_path,consent,landing_url,sync_status,sync_error,ghl_contact_id,is_test';

const MAX_ROWS = 500;
// Long enough for a human to click it, short enough that a copied link dies.
const RESUME_URL_TTL_SECONDS = 300;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const typeParam = req.nextUrl.searchParams.get('type');
  let query = sb
    .from('site_submissions')
    .select(LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (typeParam && (SITE_FORM_TYPES as readonly string[]).includes(typeParam)) {
    query = query.eq('form_type', typeParam);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Mint a signed URL per resume. Done here rather than stored on the row so
  // the link cannot outlive the request that asked for it.
  const withResumes = await Promise.all(
    rows.map(async (row) => {
      const path = row.resume_path;
      if (typeof path !== 'string' || !path) return { ...row, resume_url: null };
      const { data: signed } = await sb.storage
        .from('applications')
        .createSignedUrl(path, RESUME_URL_TTL_SECONDS);
      return { ...row, resume_url: signed?.signedUrl ?? null };
    }),
  );

  return NextResponse.json({ submissions: withResumes });
}
