// Resolve the customer-portal "before" and "after" photos from the
// renders pipeline.
//
// The renders table holds every Gemini run for every quote. For the
// portal we want the LATEST one with status='approved' (the admin
// approved the result on /admin/renders) — falling back to the latest
// 'ready' render if none has been approved yet. If neither exists,
// the portal hero hides the photo and shows the address-only headline.
//
// Both source.jpg and final.png live in the private `renders` storage
// bucket. The portal uses signed URLs (1 hour TTL) — the bucket itself
// has NO anon SELECT policy, so direct unsigned access from the
// browser is impossible. See REVIEW 2026-04-22 § C bucket RLS.

import { getSupabaseServiceClient } from '@/lib/supabase';
import type { PortalVariantPhotos } from '@/components/portal/types';

export type PortalPhotos = {
  beforeUrl: string | null;
  afterUrl: string | null;            // URL of the 'full' variant render
  variantUrls: PortalVariantPhotos;   // per-package preview URLs
  alt: string | null;
};

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

type RenderArtifactRow = {
  id: string;
  status: string;
  variant: string;
  source_path: string | null;
  final_path: string | null;
  created_at: string;
};

// Customer-facing variants we surface on portal package cards. 'full' is
// the hero shot (mapped to afterUrl); the rest land in variantUrls.
const PORTAL_VARIANT_KEYS = new Set(['santas', 'ridge', 'minis', 'wreaths', 'spritzers', 'garland']);

export async function fetchPortalPhotos(
  quoteId: string,
  customerAddress: string | null,
): Promise<PortalPhotos> {
  const fallback: PortalPhotos = {
    beforeUrl: null,
    afterUrl: null,
    variantUrls: {},
    alt: customerAddress ? `Photo of ${customerAddress}` : null,
  };

  // Top-level guard — anything that throws below (DB blip, storage 5xx,
  // missing bucket, RLS misconfig) returns the fallback instead of
  // crashing the page render. The hero hides itself when URLs are null.
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return fallback;

    // Pull the latest render per variant. We over-fetch (50) to make sure
    // we see at least one ready/approved row per variant even if some
    // variants have multiple rejected/superseded historical rows ahead of
    // them. The unique-by-variant filter happens in code below.
    const { data, error } = await sb
      .from('renders')
      .select('id, status, variant, source_path, final_path, created_at')
      .eq('quote_id', quoteId)
      .not('final_path', 'is', null)
      .in('status', ['approved', 'ready'])
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !data || data.length === 0) return fallback;

    const rows = data as RenderArtifactRow[];

    // For each variant: prefer approved → ready, latest first.
    const pickPerVariant = new Map<string, RenderArtifactRow>();
    for (const r of rows) {
      const cur = pickPerVariant.get(r.variant);
      if (!cur) {
        pickPerVariant.set(r.variant, r);
        continue;
      }
      // 'approved' beats 'ready'; same status keeps the newer row (already
      // ordered DESC so first-seen wins).
      if (cur.status !== 'approved' && r.status === 'approved') {
        pickPerVariant.set(r.variant, r);
      }
    }

    const fullPick = pickPerVariant.get('full');

    const [beforeUrl, afterUrl] = await Promise.all([
      fullPick?.source_path ? signOrNull(sb, fullPick.source_path) : Promise.resolve(null),
      fullPick?.final_path ? signOrNull(sb, fullPick.final_path) : Promise.resolve(null),
    ]);

    // Sign the per-package variant URLs in parallel — even with 6 of them
    // this is fast (<200ms total) and the customer portal is the hot path.
    const variantUrls: PortalVariantPhotos = {};
    const variantPromises: Promise<void>[] = [];
    for (const [variant, row] of pickPerVariant) {
      if (!PORTAL_VARIANT_KEYS.has(variant)) continue;
      if (!row.final_path) continue;
      variantPromises.push(
        signOrNull(sb, row.final_path).then(url => {
          if (url) (variantUrls as Record<string, string>)[variant] = url;
        }),
      );
    }
    await Promise.all(variantPromises);

    return {
      beforeUrl,
      afterUrl,
      variantUrls,
      alt: customerAddress
        ? `${customerAddress} — daytime and rendered with holiday lights`
        : 'Holiday lights render',
    };
  } catch (err) {
    console.warn('[fetchPortalPhotos] degrading to fallback:', err);
    return fallback;
  }
}

async function signOrNull(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  path: string,
): Promise<string | null> {
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage
      .from('renders')
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    // Network blip or path missing — caller will hide the photo.
    return null;
  }
}
