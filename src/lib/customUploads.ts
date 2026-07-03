// Server-side custom graphic library (#32 Phase 3). Staff-uploaded item images
// stored in the PUBLIC `custom-uploads` Storage bucket, indexed by the
// `custom_uploads` table (keeps the original filename + a stable id). A placed
// custom scene item stores the object `path` as its `imagePath`; the editor +
// portal resolve it via /photos/<path>. See migrations/2026-06-17-custom-uploads.sql.

import { getSupabaseServiceClient } from './supabase';
import type { CustomUpload } from './design/sceneTypes';

const BUCKET = 'custom-uploads';

// Allowed image types → file extension (mirrors the editor's file-input accept).
// Audit fix (g28): `image/svg+xml` removed — SVGs land unmodified in the PUBLIC
// bucket and an SVG can carry inline <script>, a stored-XSS vector if ever
// opened top-level. Raster formats only. (Existing placed SVGs still resolve
// via /photos; this only blocks NEW svg uploads.)
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isAllowedImageType(contentType: string): boolean {
  return contentType in EXT_BY_TYPE;
}

// Pick the extension from the content type, falling back to the filename's
// extension (lowercased) so e.g. an octet-stream upload with a .png name still
// stores sensibly. Returns null if neither yields an allowed type.
export function extFor(contentType: string, filename: string): string | null {
  if (EXT_BY_TYPE[contentType]) return EXT_BY_TYPE[contentType];
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = m?.[1]?.toLowerCase();
  const allowed = new Set(Object.values(EXT_BY_TYPE));
  return ext && allowed.has(ext === 'jpeg' ? 'jpg' : ext) ? (ext === 'jpeg' ? 'jpg' : ext) : null;
}

function publicUrl(path: string): string {
  const sb = getSupabaseServiceClient();
  if (!sb) return `/photos/${path}`;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function rowToUpload(row: { id: string; filename: string; path: string; created_at: string }): CustomUpload {
  return {
    id: row.id,
    filename: row.filename,
    path: row.path,
    url: publicUrl(row.path),
    uploadedAt: new Date(row.created_at).getTime(),
  };
}

export async function listCustomUploads(): Promise<CustomUpload[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('custom_uploads')
    .select('id, filename, path, created_at')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[customUploads] list failed:', error.message);
    return [];
  }
  return (data ?? []).map(rowToUpload);
}

export async function createCustomUpload(input: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}): Promise<CustomUpload> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const ext = extFor(input.contentType, input.filename);
  if (!ext) throw new Error('Unsupported image type');

  const id = crypto.randomUUID();
  const path = `${id}.${ext}`;
  const contentType = isAllowedImageType(input.contentType) ? input.contentType : `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, input.buffer, {
    contentType,
    upsert: false,
  });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  const filename = input.filename.trim() || path;
  const { data, error } = await sb
    .from('custom_uploads')
    .insert({ id, filename, path })
    .select('id, filename, path, created_at')
    .single();
  if (error || !data) {
    // Roll back the orphaned object so a failed insert doesn't leak storage.
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    throw new Error(`index insert failed: ${error?.message ?? 'no row'}`);
  }
  return rowToUpload(data);
}

export async function deleteCustomUpload(id: string): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const { data, error } = await sb
    .from('custom_uploads')
    .select('path')
    .eq('id', id)
    .single();
  if (error) {
    // W2-028: .single() also errors on a real/transient DB failure, not just
    // "no rows" — only PGRST116 (PostgREST's no-rows-found code) means
    // already-gone. Any other error must surface, not be silently swallowed
    // as success.
    if (error.code === 'PGRST116') return;
    throw new Error(`lookup failed: ${error.message}`);
  }
  if (!data) return; // already gone — treat as success
  await sb.storage.from(BUCKET).remove([data.path]).catch(() => {});
  const { error: delErr } = await sb.from('custom_uploads').delete().eq('id', id);
  if (delErr) throw new Error(`delete failed: ${delErr.message}`);
}

// Audit fix (g28): custom-upload object paths are always minted as `{uuid}.{ext}`
// (see createCustomUpload). Validate against exactly that shape before resolving
// so the public /photos route can't be coaxed into building a Supabase URL for an
// arbitrary / path-traversal object path. Returns true only for a well-formed key.
const UPLOAD_PATH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|svg)$/;

export function isValidUploadPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && UPLOAD_PATH_RE.test(path);
}

// Resolve an object path to its public URL (used by the /photos route so the
// editor + portal `imagePath` convention resolves). Returns null if unset or if
// the path isn't a well-formed `{uuid}.{ext}` upload key (audit fix g28).
export function resolvePublicUrl(path: string | null | undefined): string | null {
  if (!isValidUploadPath(path)) return null;
  return publicUrl(path!);
}
