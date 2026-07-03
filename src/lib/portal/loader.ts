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
import { applyOurRecommendation } from './derivePackages';

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
        // Bug fix (B3): added status, decline_reason, quote_sent_at, viewed_at
        // so the portal can gate the approve+pay UI for terminal/branch quotes.
        'id, customer_name, customer_address, customer_phone, customer_email, result, inputs, total, video_kind, video_src, video_poster, video_title, video_duration_sec, customer_approved_at, approval_snapshot, deposit_paid_at, status, decline_reason, quote_sent_at, viewed_at, is_test',
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
            // Satellite roof view (#51) — carried through so WhatsIncluded can
            // show the top-down image + roofline lines. Null/absent fields make
            // the section hide.
            satelliteUrl: design.satelliteUrl,
            satelliteW: design.satelliteW,
            satelliteH: design.satelliteH,
            satelliteLines: design.satelliteLines,
            // #13 multi-image: extra photos (signed URLs) for the hero strip,
            // reprise arrows, and the all-photos gallery.
            extraPhotos: design.extraPhotos,
          };
          // Link line items ⇄ scene items so the portal can hide a drawn item
          // when its line item is toggled off (#27 D). Additive — same ids, just
          // gains sceneItemIds AND the design-driven `recommended` flag (#12).
          portal.lineItems = attachSceneLinks(portal.lineItems, design.scene);
        }
      } catch (err) {
        console.error('[loadPortalQuote] design lookup failed:', err);
      }
      // Populate the "Our Recommendation" (D) card from the staff-recommended
      // line items (#12, Jason S12). Runs after attachSceneLinks so design-driven
      // recommended flags are attached; also covers custom-item recommendations
      // the adapter set. No-op (D stays "Build Your Own") when nothing is flagged.
      portal.packages = applyOurRecommendation(
        portal.packages,
        portal.lineItems,
        portal.roofline,
        portal.charges,
      );
    }
    return portal;
  } catch (err) {
    console.error('[loadPortalQuote] unexpected error:', err);
    return null;
  }
}
