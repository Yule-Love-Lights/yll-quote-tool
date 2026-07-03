// Custom graphic library API (task #32 Phase 3).
//   GET  /api/uploads        → CustomUpload[] (newest first)
//   POST /api/uploads        → CustomUpload   (multipart form field `file`)
// Service-role only (app-wide staff assets, not per-user).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listCustomUploads, createCustomUpload, isAllowedImageType } from '@/lib/customUploads';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches the photo/upload limits elsewhere

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await listCustomUploads());
  } catch (err) {
    console.error('[api/uploads] GET failed:', err);
    return NextResponse.json({ error: 'Failed to list uploads' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 });
  }
  // #110 W2-024: svg dropped from the fallback — the lib (isAllowedImageType/
  // extFor) deliberately rejects SVG (stored-XSS risk in the public bucket),
  // so letting it pass here just deferred the rejection into a 500.
  if (!isAllowedImageType(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const upload = await createCustomUpload({ buffer, filename: file.name, contentType: file.type });
    return NextResponse.json(upload);
  } catch (err) {
    console.error('[api/uploads] POST failed:', err);
    return NextResponse.json({ error: 'Failed to upload' }, { status: 500 });
  }
}
