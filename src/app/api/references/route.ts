import { NextRequest, NextResponse } from 'next/server';
import {
  saveReferenceAsset,
  listReferenceAssets,
  ReferenceAssetPayload,
} from '@/lib/referenceAssets';
import { isSupabaseConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Reference library requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }
  const items = await listReferenceAssets();
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Reference library requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }

  let body: ReferenceAssetPayload;
  try {
    body = (await req.json()) as ReferenceAssetPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.assetType || !body.size || !body.base64 || !body.mediaType) {
    return NextResponse.json(
      { error: 'assetType, size, base64, and mediaType are required' },
      { status: 400 },
    );
  }
  if (!['spritzer', 'wreath', 'garland'].includes(body.assetType)) {
    return NextResponse.json({ error: 'Invalid assetType' }, { status: 400 });
  }

  const saved = await saveReferenceAsset(body);
  if (!saved) {
    return NextResponse.json(
      { error: 'Failed to save reference — check server logs' },
      { status: 500 },
    );
  }
  return NextResponse.json({ id: saved.id });
}
