// Supabase storage + renders-table access layer. Isolated from the render
// pipeline so the orchestrator doesn't need to know Supabase exists.
//
// Layout in the `renders` storage bucket:
//   {renderId}/source.jpg
//   {renderId}/composite.png
//   {renderId}/mask.png
//   {renderId}/final.png

import { createHash } from 'crypto';
import { getSupabaseServiceClient } from '@/lib/supabase';
import type {
  RenderListItem,
  RenderModel,
  RenderStatus,
  RenderStyle,
  RenderVariant,
  StoredRender,
} from './types';

// All ops in this module run server-side with the service-role key so they
// bypass RLS. Anon's SELECT policy only allows status='approved', which
// would break the full render lifecycle (pending→rendering→ready→approved).
// The service client is NEVER exposed to the browser. See REVIEW 2026-04-22.
const getSb = getSupabaseServiceClient;

const BUCKET = 'renders';

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function hashJson(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// Prompt version — part of the cache key. Bump this whenever the Gemini
// prompt, negative-suffix logic, or compositor mask-drawing logic changes
// in a way that would produce a materially different image for the same
// vision+photo inputs. Otherwise the orchestrator's cache will happily
// serve the pre-change render forever.
//
// History:
//   v1 — initial launch (Phase 1)
//   v2 — 2026-04-23: added negative prompt suffix for empty categories
//        + Gemini MALFORMED_FUNCTION_CALL retry loop
//   v3 — 2026-04-23: removed solar-panel-specific analyzer branches (too
//        narrow — misfired on non-panel houses). Replaced with generic
//        "mid-slope features don't define edges" rule + stronger ridge
//        emphasis in the Gemini prompt so ridge bulbs render even when
//        the roof slope has dark/reflective surface features.
//   v4 — 2026-04-23: toned down bulb size language ("small plum/strawberry
//        NOT golf ball or tangerine") after first Replicate-enabled render
//        showed oversized roofline bulbs. Strengthened sprite count integrity
//        (explicit "count them yourself before finalizing"). Added left/right
//        symmetry self-check to analyzer so missed sides of the roofline are
//        caught before returning.
//   v5 — 2026-04-23: v4 bulb sizing still too large. Reduced composite
//        BULB_DIAMETER_AT_1000PX from 8 to 5 (visual reference anchor) and
//        added architectural size references in the Gemini prompt (bulb ≈
//        gutter trough width, ≈ 1/40 window height, < wreath bow). Removes
//        "commercial carnival" look in favor of refined residential.
//   v6 — 2026-04-23: spritzer visibility fix. Raw spritzer sprite was pale
//        cream on transparent — invisible against dusk base, so Gemini
//        dropped them. Added warm radial glow halo under each sprite +
//        brightness/saturation boost on the sprite itself + bumped min
//        sprite size from 7% to 9% of width.
//   v7 — 2026-04-23: v6 spritzer halos were too bright — pooled warm light
//        onto surrounding grass. Pulled halo opacity down (0.85→0.45,
//        0.45→0.20), halo size 1.5x→1.3x, sprite modulate 1.8/1.5→1.4/1.3.
//        Spritzers still visible, just not "lawn lantern" bright.
//   v8 — 2026-04-23: three fixes in one pass:
//        (1) Power-line hallucination guard — Gemini painted an extra run of
//            lights along a utility wire crossing near the roofline. Added
//            rule to analyzer (don't trace wires/branches/fences as roof
//            edges) and to Gemini prompt (never paint lights on power lines,
//            telephone wires, service drops, or non-house objects).
//        (2) Roofline continuity — Gemini skipped bulbs mid-run on this same
//            render. Added explicit "maintain continuity, do not drop bulbs
//            because the background is dark or a branch crosses in front"
//            directive to the COUNT INTEGRITY block.
//        (3) Spritzer size pullback — v7 size felt ~20% too large at the
//            composite stage. Reduced spritzerMinSide from width*0.09 to
//            width*0.075 so rendered stakes sit closer to a real ~2ft
//            footprint relative to the house.
//   v9 — 2026-04-23: v8 roofline-continuity paragraph still allowed Gemini
//        to skip one bulb mid-run (visible gap in the front gutter). Rewrote
//        as a stronger directive: each composite dot is a "billable installed
//        C9 bulb," 1:1 mapping, plus an explicit pre-finalize checklist
//        (scan left-to-right, count composite bulbs, count rendered bulbs,
//        regenerate if counts don't match). Enumerates the common false
//        excuses ("dark shingle behind," "tree branch in front," etc.) so
//        the model can't rationalize a drop.
export const RENDER_PROMPT_VERSION = 9;

// Variant + a separate variant cache-bust env var both feed into the cache
// key so per-package renders can be invalidated independently of the full
// render and prompt-version bumps. Set RENDER_VARIANT_CACHE_BUST=anything
// after lowering RENDER_VARIANT_MODEL to force regeneration at the new
// (cheaper) tier without disturbing already-approved full renders.
export function cacheKeyFor(
  photoHash: string,
  visionHash: string,
  style: RenderStyle,
  model: RenderModel,
  variant: RenderVariant = 'full',
): string {
  const variantBust = variant === 'full' ? '' : `::vbust=${process.env.RENDER_VARIANT_CACHE_BUST ?? ''}`;
  return createHash('sha256')
    .update(`v${RENDER_PROMPT_VERSION}::${photoHash}::${visionHash}::${style}::${model}::${variant}${variantBust}`)
    .digest('hex');
}

// Look up a prior render for the same inputs. If one exists and is
// ready/approved AND still has a final artifact, the orchestrator skips
// the Gemini call. The final_path guard prevents serving a stale row
// whose artifacts were deleted out-of-band (see REVIEW C4).
export async function findByCacheKey(cacheKey: string): Promise<StoredRender | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('renders')
    .select('*')
    .eq('cache_key', cacheKey)
    .in('status', ['ready', 'approved'])
    .not('final_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findByCacheKey: ${error.message}`);
  return data as StoredRender | null;
}

export async function createRenderRow(row: {
  quoteId?: string;
  style: RenderStyle;
  model: RenderModel;
  variant?: RenderVariant;
  photoHash: string;
  visionHash: string;
  cacheKey: string;
  notes?: string;
}): Promise<StoredRender> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const variant: RenderVariant = row.variant ?? 'full';

  // The unique index `renders_quote_variant_style_uniq` blocks a second
  // non-rejected row for the same (quote, variant, style). When re-rendering,
  // soft-replace the old row by marking it rejected so the new INSERT wins.
  // If quote_id is null (admin smoke-test renders) the index doesn't apply,
  // so we skip this branch.
  if (row.quoteId) {
    const { error: updErr } = await sb
      .from('renders')
      .update({ status: 'rejected' as RenderStatus, rejected_reason: 'superseded by re-render' })
      .eq('quote_id', row.quoteId)
      .eq('variant', variant)
      .eq('style', row.style)
      .not('status', 'in', '(rejected,failed)');
    if (updErr) throw new Error(`createRenderRow supersede: ${updErr.message}`);
  }

  const { data, error } = await sb
    .from('renders')
    .insert({
      quote_id: row.quoteId ?? null,
      version: 1,
      style: row.style,
      model: row.model,
      variant,
      status: 'pending' as RenderStatus,
      photo_hash: row.photoHash,
      vision_hash: row.visionHash,
      cache_key: row.cacheKey,
      notes: row.notes ?? null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`createRenderRow: ${error?.message ?? 'no row returned'}`);
  return data as StoredRender;
}

export async function updateRender(id: string, patch: Partial<StoredRender>): Promise<void> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('renders').update(patch).eq('id', id);
  if (error) throw new Error(`updateRender: ${error.message}`);
}

export async function uploadArtifact(
  renderId: string,
  kind: 'source' | 'composite' | 'mask' | 'final' | 'gemini',
  buf: Buffer,
  contentType: string,
): Promise<string> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
  const path = `${renderId}/${kind}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`uploadArtifact(${kind}): ${error.message}`);
  return path;
}

export async function getSignedUrl(path: string, expiresIn = 60 * 60): Promise<string> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data) throw new Error(`getSignedUrl: ${error?.message ?? 'no url'}`);
  return data.signedUrl;
}

// Sum of gemini_cost_usd for renders created this calendar month. Used by
// orchestrator.ts to enforce RENDER_BUDGET_MONTHLY_USD before calling Gemini.
//
// Fails CLOSED on DB error (throws) — refusing a render is cheaper than
// burning Gemini $$$ blind during a Supabase outage. 60s in-memory cache
// keeps hot-path latency off the MTD sum query.
let mtdCache: { usd: number; until: number } | null = null;
const MTD_CACHE_TTL_MS = 60_000;

export async function getMonthToDateSpendUsd(): Promise<number> {
  if (mtdCache && mtdCache.until > Date.now()) return mtdCache.usd;

  const sb = getSb();
  if (!sb) return 0;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await sb
    .from('renders')
    .select('gemini_cost_usd')
    .gte('created_at', monthStart)
    .not('gemini_cost_usd', 'is', null);
  if (error) throw new Error(`getMonthToDateSpendUsd: ${error.message}`);
  const sum = (data ?? []).reduce(
    (s: number, r: { gemini_cost_usd: number | null }) => s + (r.gemini_cost_usd ?? 0),
    0,
  );
  mtdCache = { usd: sum, until: Date.now() + MTD_CACHE_TTL_MS };
  return sum;
}

// Invalidate the MTD cache after a new render charge lands so back-to-back
// calls can't race past the budget. Called by the orchestrator on success.
export function invalidateMtdCache(): void {
  mtdCache = null;
}

export async function listRenders(limit = 100): Promise<RenderListItem[]> {
  const sb = getSb();
  if (!sb) return [];
  const { data, error } = await sb
    .from('renders')
    .select('id, quote_id, version, style, model, variant, status, ssim_score, gemini_cost_usd, notes, created_at, updated_at, approved_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRenders: ${error.message}`);
  return (data ?? []) as RenderListItem[];
}

// All non-rejected renders for a quote, one row per variant. Used by the
// admin variant grid (filter for status='ready'/'approved') and the
// customer portal (filter for status='approved').
export async function getRendersForQuote(quoteId: string): Promise<StoredRender[]> {
  const sb = getSb();
  if (!sb) return [];
  const { data, error } = await sb
    .from('renders')
    .select('*')
    .eq('quote_id', quoteId)
    .not('status', 'in', '(rejected,failed)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getRendersForQuote: ${error.message}`);
  return (data ?? []) as StoredRender[];
}

// Approve every non-rejected render for a quote in one call. Used by the
// admin "Approve all variants" action so reviewers don't have to click 7
// times per quote. Returns the count actually flipped.
export async function approveAllForQuote(quoteId: string, approver: string): Promise<number> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const { data, error } = await sb
    .from('renders')
    .update({
      status: 'approved' as RenderStatus,
      approved_at: new Date().toISOString(),
      approved_by: approver,
    })
    .eq('quote_id', quoteId)
    .in('status', ['ready', 'rendering'])
    .select('id');
  if (error) throw new Error(`approveAllForQuote: ${error.message}`);
  return (data ?? []).length;
}

export async function getRender(id: string): Promise<StoredRender | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('renders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getRender: ${error.message}`);
  return data as StoredRender | null;
}

export async function approveRender(id: string, approver: string): Promise<void> {
  await updateRender(id, {
    status: 'approved',
    approved_at: new Date().toISOString(),
    approved_by: approver,
  });
}

export async function rejectRender(id: string, reason: string): Promise<void> {
  await updateRender(id, {
    status: 'rejected',
    rejected_reason: reason,
  });
}

export async function deleteRender(id: string): Promise<void> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  // Best-effort storage cleanup — remove all artifacts in the render's folder.
  const { data: files } = await sb.storage.from(BUCKET).list(id);
  if (files && files.length > 0) {
    await sb.storage.from(BUCKET).remove(files.map(f => `${id}/${f.name}`));
  }
  const { error } = await sb.from('renders').delete().eq('id', id);
  if (error) throw new Error(`deleteRender: ${error.message}`);
}
