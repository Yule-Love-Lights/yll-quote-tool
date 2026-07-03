import { NextRequest, NextResponse } from 'next/server';
import {
  saveReferenceAsset,
  listReferenceAssets,
  ReferenceAssetPayload,
} from '@/lib/referenceAssets';
import { isSupabaseConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
// #110 W5-003: validate size/tier against the same allowed sets the
// scene-correction sanitizers use, so the reference-corpus write path and
// the training-scene write path agree on what a valid product label is.
import { WREATH_SIZES, SPRITZER_SIZES, GARLAND_LENGTHS, TIERS } from '@/lib/design/sceneCorrections';

export const runtime = 'nodejs';
export const maxDuration = 60;

// #110 W5-004: same allowlist analyzePhoto() enforces before building a Claude
// vision image block — a reference saved with any other mediaType would make
// EVERY subsequent analyze call fail once it's read back out of the corpus.
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Base64 has no embedded size; cap the encoded string length to roughly the
// same 10MB ceiling the other image-upload routes (analyze-photo, uploads) use.
const MAX_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CAPTION_LEN = 300;

const SIZE_SETS: Record<ReferenceAssetPayload['assetType'], readonly string[]> = {
  wreath: WREATH_SIZES,
  spritzer: SPRITZER_SIZES,
  garland: GARLAND_LENGTHS,
};

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
  // W5-004 — mediaType must be a real image type: this gets re-injected as a
  // Claude vision image block on every future analyze call, and a bad type
  // makes Anthropic reject the whole request corpus-wide.
  if (!ALLOWED_MEDIA_TYPES.has(body.mediaType)) {
    return NextResponse.json({ error: 'Invalid mediaType — must be a supported image type' }, { status: 400 });
  }
  // W5-004 — base64 must actually be well-formed base64, and size-capped like
  // the other image-upload routes.
  if (typeof body.base64 !== 'string' || body.base64.length === 0 || body.base64.length > MAX_BASE64_CHARS || !BASE64_RE.test(body.base64)) {
    return NextResponse.json({ error: 'Invalid base64 image data' }, { status: 400 });
  }
  // W5-003 — size must be from the type-appropriate allowed set (mirrors
  // applyItemCorrections in sceneCorrections.ts), and tier from the fixed set.
  if (!SIZE_SETS[body.assetType].includes(body.size)) {
    return NextResponse.json({ error: `Invalid size for ${body.assetType}` }, { status: 400 });
  }
  if (body.tier != null && !TIERS.includes(body.tier as (typeof TIERS)[number])) {
    return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
  }

  const caption = body.caption?.trim().slice(0, MAX_CAPTION_LEN) || null;
  const saved = await saveReferenceAsset({ ...body, caption });
  if (!saved) {
    return NextResponse.json(
      { error: 'Failed to save reference — check server logs' },
      { status: 500 },
    );
  }
  return NextResponse.json({ id: saved.id });
}
