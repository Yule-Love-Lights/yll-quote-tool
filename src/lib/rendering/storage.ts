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

export function cacheKeyFor(photoHash: string, visionHash: string, style: RenderStyle, model: RenderModel): string {
  return createHash('sha256').update(`${photoHash}::${visionHash}::${style}::${model}`).digest('hex');
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
  photoHash: string;
  visionHash: string;
  cacheKey: string;
  notes?: string;
}): Promise<StoredRender> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase not configured');
  const { data, error } = await sb
    .from('renders')
    .insert({
      quote_id: row.quoteId ?? null,
      version: 1,
      style: row.style,
      model: row.model,
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
  kind: 'source' | 'composite' | 'mask' | 'final',
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
    .select('id, quote_id, version, style, model, status, ssim_score, gemini_cost_usd, notes, created_at, updated_at, approved_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRenders: ${error.message}`);
  return (data ?? []) as RenderListItem[];
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
