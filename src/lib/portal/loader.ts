// Server-only loader. Single source of truth for "fetch a quote by id and
// return the PortalQuote shape." Both the API route (/api/quotes/[id])
// and the portal page (/portal/[quoteId]) call this so we never end up
// with two slightly-different DB read paths drifting apart.
//
// Returns:
//   - PortalQuote on success
//   - null when the quote is missing OR has no pricing result yet
//   - throws ConfigError when Supabase isn't configured (caller decides
//     whether to fall back to mocks for dev)

import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import type { PortalQuote } from '@/components/portal/types';
import { quoteRowToPortalQuote, type QuoteRowForPortal } from './adapter';
import { fetchPortalPhotos } from './photos';
import { getDesignByQuote } from '@/lib/designs';
import { attachSceneLinks } from './sceneLinks';

export class PortalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalConfigError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidQuoteId(id: string): boolean {
  return UUID_RE.test(id);
}

export async function loadPortalQuote(id: string): Promise<PortalQuote | null> {
  if (!isSupabaseServiceConfigured()) {
    throw new PortalConfigError('Supabase service role not configured');
  }
  if (!isValidQuoteId(id)) return null;

  // Catch anything that throws below — DB error, malformed jsonb, parser
  // crash on an unexpected line-item label, etc. Returning null hands
  // control back to the caller (page or API route) which decides whether
  // to 404 or fall back to mock. Crashing the worker is never the right
  // answer — Next.js's Turbopack pool is unforgiving about uncaught
  // exceptions in Server Components.
  try {
    const sb = getSupabaseServiceClient()!;
    const { data, error } = await sb
      .from('quotes')
      .select(
        'id, customer_name, customer_address, customer_phone, customer_email, result, total, video_kind, video_src, video_poster, video_title, video_duration_sec, customer_approved_at, approval_snapshot',
      )
      .eq('id', id)
      .maybeSingle<QuoteRowForPortal>();

    if (error) {
      console.error('[loadPortalQuote] DB error:', error);
      return null;
    }
    if (!data) return null;

    const photos = fetchPortalPhotos(data.customer_address);
    const portal = quoteRowToPortalQuote({ row: data, photos });
    // Attach the linked design (if any) so the hero can render it live (#27
    // Phase 2). Best-effort: a design lookup failure never blocks the quote.
    if (portal) {
      try {
        const design = await getDesignByQuote(id);
        if (design) {
          portal.design = {
            scene: design.scene,
            photoUrl: design.photoUrl,
            photoW: design.photoW,
            photoH: design.photoH,
          };
          // Link line items ⇄ scene items so the portal can hide a drawn item
          // when its line item is toggled off (#27 D). Additive — same ids, just
          // gains sceneItemIds; packages/selection are unaffected.
          portal.lineItems = attachSceneLinks(portal.lineItems, design.scene);
        }
      } catch (err) {
        console.error('[loadPortalQuote] design lookup failed:', err);
      }
    }
    return portal;
  } catch (err) {
    console.error('[loadPortalQuote] unexpected error:', err);
    return null;
  }
}
