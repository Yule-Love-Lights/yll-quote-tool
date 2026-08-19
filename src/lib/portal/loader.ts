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
import { isWisetackFinancingEnabled, getWisetackPrequalUrl } from '@/lib/integrations/wisetack';
import { financedBalanceUsd } from '@/lib/financing/eligibility';
import { resolveAgreedTotal } from '@/lib/agreedTotal';

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
    // W4-016: getDesignByQuote only needs the URL id (already known), so kick
    // it off in parallel with the quote row fetch instead of after it — same
    // best-effort contract, just started earlier. Its own try/catch below still
    // isolates a design-lookup failure from the quote fetch/parse path; a
    // rejection here is caught at the Promise.all and re-thrown into that same
    // catch so the behavior (never blocks the quote) is unchanged.
    const [{ data, error }, designResult] = await Promise.all([
      sb
        .from('quotes')
        .select(
          // Bug fix (B3): added status, decline_reason, quote_sent_at, viewed_at
          // so the portal can gate the approve+pay UI for terminal/branch quotes.
          // #88 P5: added service_type so the adapter can route permanent quotes
          // to their own package derivation + rate-snapshot minimum gate.
          // #41: added customer_id so the booked-page referral section can
          // ensure/read this customer's referral code.
          // #155: added legacy_rebook so the portal can show the legacy-rebook
          // variant (LightColorPicker copy/toggle + WhatsIncluded read-only items).
          // #176: added view_only so the portal can show the browsing-only
          // sticky bar and skip mounting the approve/pay/decline machinery.
          'id, customer_id, customer_name, customer_address, customer_phone, customer_email, result, inputs, total, video_kind, video_src, video_poster, video_title, video_duration_sec, customer_approved_at, approval_snapshot, deposit_paid_at, status, decline_reason, quote_sent_at, viewed_at, is_test, service_type, legacy_rebook, view_only',
        )
        .eq('id', id)
        .maybeSingle<QuoteRowForPortal>(),
      getDesignByQuote(id).then(
        (design) => ({ ok: true as const, design }),
        (err) => ({ ok: false as const, err }),
      ),
    ]);

    if (error) {
      console.error('[loadPortalQuote] DB error:', error);
      return null;
    }
    if (!data) return null;

    // Delta-verify HIGH (fix round 3): this used to also fetch the linked
    // job + invoice here (FIX4) just to read invoice.tax_overridden, so the
    // adapter could reconstruct an invoice-basis total from it on every
    // load. That reconstruction is gone: the amend route now stamps the
    // invoice-basis previous/new/delta directly onto the trail entry at
    // amend time (amend.ts's AmendmentTrailEntry.invoice_basis; read by
    // adapter.ts's buildApproval), so the portal reads a recorded number and
    // never needs a live invoice lookup to render the card. This also
    // resolves the round-2 MEDIUM finding by elimination rather than by
    // narrowing: that extra round-trip previously fired on every load of any
    // quote that ever had an amendment — including routine $0-delta
    // free-item/colour-change entries, forever — and now never fires at all.
    const photos = fetchPortalPhotos(data.customer_address);
    const portal = quoteRowToPortalQuote({ row: data, photos });
    // Attach the linked design (if any) so the hero can render it live (#27
    // Phase 2). Best-effort: a design lookup failure never blocks the quote.
    if (portal) {
      try {
        if (!designResult.ok) throw designResult.err;
        const design = designResult.design;
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
      // HOLIDAY ONLY (positive-match, #117 review): permanent (#88 P5), event
      // (#96), and permanent bistro (#117) ALL repurpose package 'D' as a real
      // bundle (Whole Home / the single event or bistro package).
      // applyOurRecommendation assumes 'D' is the empty holiday recommendation
      // slot and would CLOBBER it — dropping items from the default selection —
      // if any line item is flagged recommended. The old negative gate
      // (!== permanent && !== event) silently handed that clobber to bistro,
      // the exact AGENTS.md negative-gate pitfall. A null/legacy service_type
      // reads as holiday — the DEFAULT.
      // LEGACY REBOOK carve-out (#155): a legacy rebook IS a holiday quote,
      // but its adapter repurposes 'D' as the single "Last Year's Design"
      // bundle (same reason the other verticals are excluded), so the
      // positively-matched legacy flag skips the rewrite here too.
      const isLegacyRebook = data.legacy_rebook === true;
      if (!isLegacyRebook && (data.service_type == null || data.service_type === 'holiday')) {
        portal.packages = applyOurRecommendation(
          portal.packages,
          portal.lineItems,
          portal.roofline,
          portal.charges,
        );
      }
      // #154 interim — Wisetack prequal financing. Server-read env (never
      // bundled client-side), attached ONLY when the flag is exactly on AND a
      // prequal URL exists — flag off leaves the portal object untouched.
      // approvedBalanceUsd follows the plan's money note: the agreed total
      // (amendment-aware, via resolveAgreedTotal) minus the snapshot's frozen
      // deposit; null when unapproved or the deposit is unknown (POSITIVE
      // gate — never guess a financed amount from a partial snapshot).
      const prequalUrl = getWisetackPrequalUrl();
      if (isWisetackFinancingEnabled() && prequalUrl) {
        const snap = data.approval_snapshot;
        const dep = snap?.customerSelection?.currentDepositUsd;
        const hasApprovedMoney =
          !!data.customer_approved_at && !!snap && typeof dep === 'number' && Number.isFinite(dep);
        const approvedTotalUsd = hasApprovedMoney ? resolveAgreedTotal(snap, data.result) : null;
        const approvedBalanceUsd =
          approvedTotalUsd != null ? financedBalanceUsd(approvedTotalUsd, dep as number) : null;
        portal.financing = { prequalUrl, approvedTotalUsd, approvedBalanceUsd };
      }
    }
    return portal;
  } catch (err) {
    console.error('[loadPortalQuote] unexpected error:', err);
    return null;
  }
}
