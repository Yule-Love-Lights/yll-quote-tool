import sharp from 'sharp';
import { getSupabaseServiceClient } from './supabase';
import type { Scene } from './design/sceneTypes';
import {
  seedRooflineStrands,
  seedLinesHaveContent,
  type RooflineSeedLines,
} from './design/seedRoofline';

// Server-side business logic for the design-tool integration (Path B, task #27
// Phase 1). A "design" is one editable on-photo light layout. The `scene` is
// the design tool's Scene JSON (yardsticks + items + brightness); we treat it
// as opaque jsonb here — the editor owns its internal shape. A design is an
// INDEPENDENT record with its own id and an OPTIONAL link to a quote, set when
// the operator clicks "Calculate Quote".
//
// All access is via the service-role client: the `designs` Storage bucket is
// private (no anon policies), so uploads + signed URLs require the service key.

// The stored scene IS the design tool's Scene shape (vendored in
// ./design/sceneTypes — types + guards + the contract's binding fields).
// Kept as a `DesignScene` alias so the API routes' imports don't churn.
export type DesignScene = Scene;

export const EMPTY_SCENE: DesignScene = { yardsticks: [], items: [] };

export type DesignRow = {
  id: string;
  quote_id: string | null;
  photo_path: string | null;
  photo_w: number | null;
  photo_h: number | null;
  scene: DesignScene;
  created_at: string;
  updated_at: string;
};

// What the GET route hands the editor: the row plus a freshly-signed,
// time-limited URL for the private base photo (or null if there's no photo).
export type DesignWithPhoto = {
  id: string;
  quoteId: string | null;
  scene: DesignScene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
};

const BUCKET = 'designs';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour, matches the renders pipeline.

const UUID_RE = /^[0-9a-f-]{36}$/i;
export function isValidDesignId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function getSb() {
  // Service-role only — the bucket is private and the table has RLS disabled.
  return getSupabaseServiceClient();
}

// Sign a private storage path into a temporary public URL. Returns null on any
// failure so the editor can fall back to its empty "upload a photo" state.
export async function signDesignPhoto(path: string | null): Promise<string | null> {
  if (!path) return null;
  const sb = getSb();
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

// Create a new design row. Optionally link it to a quote, seed its base photo
// from a base64 data payload (the Street View image the builder already has in
// hand), and/or seed roofline strands from the builder's measurement polylines
// (#33 — the polylines arrive pre-split red/blue, so the strands land tagged
// `santas-roofline`/`gingerbread`/`winter-wonderland` and the portal's
// picture-toggle works with zero manual tagging). Returns the new id, or null
// if Supabase isn't configured.
export async function createDesign(opts: {
  quoteId?: string | null;
  photoBase64?: string | null;
  photoMediaType?: string | null;
  seedLines?: RooflineSeedLines | null;
}): Promise<{ id: string } | null> {
  const sb = getSb();
  if (!sb) return null;

  const { data, error } = await sb
    .from('designs')
    .insert({
      quote_id: opts.quoteId ?? null,
      scene: EMPTY_SCENE,
    })
    .select('id')
    .single();
  if (error) {
    console.error('Supabase createDesign error:', error);
    return null;
  }
  const id = data.id as string;

  // Seed the base photo if one was supplied with the create call.
  if (opts.photoBase64) {
    try {
      const photo = await uploadDesignPhoto(id, opts.photoBase64, opts.photoMediaType ?? 'image/jpeg');
      // Roofline seeding needs the photo's pixel dimensions — only possible
      // when a photo came with the create call (the lines are drawn on it).
      if (opts.seedLines && seedLinesHaveContent(opts.seedLines) && photo.width > 0 && photo.height > 0) {
        const scene = seedRooflineStrands(EMPTY_SCENE, opts.seedLines, photo.width, photo.height);
        await updateDesignScene(id, scene);
      }
    } catch (err) {
      // A failed photo/roofline seed isn't fatal — the design still exists and
      // the operator can upload a photo / sync the roofline from the builder.
      console.error('createDesign: photo/roofline seed failed:', err);
    }
  }
  return { id };
}

export async function getDesign(id: string): Promise<DesignRow | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb.from('designs').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error('Supabase getDesign error:', error);
    return null;
  }
  return (data as DesignRow | null) ?? null;
}

// Load a design and attach a signed URL for its base photo — the shape the
// editor mounts from.
export async function getDesignWithPhoto(id: string): Promise<DesignWithPhoto | null> {
  const row = await getDesign(id);
  if (!row) return null;
  return {
    id: row.id,
    quoteId: row.quote_id,
    scene: row.scene ?? EMPTY_SCENE,
    photoUrl: await signDesignPhoto(row.photo_path),
    photoW: row.photo_w,
    photoH: row.photo_h,
  };
}

// The design linked to a given quote, if any (used when re-opening a quote
// that already has a design).
export async function getDesignByQuote(quoteId: string): Promise<DesignWithPhoto | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('designs')
    .select('id')
    .eq('quote_id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('Supabase getDesignByQuote error:', error);
    return null;
  }
  if (!data) return null;
  return getDesignWithPhoto(data.id as string);
}

// Autosave path: overwrite the scene jsonb. The DB trigger bumps updated_at.
export async function updateDesignScene(id: string, scene: DesignScene): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb.from('designs').update({ scene }).eq('id', id);
  if (error) {
    console.error('Supabase updateDesignScene error:', error);
    return false;
  }
  return true;
}

// Link an existing design to a quote (set when the operator clicks "Calculate
// Quote"). The partial unique index allows at most one design per quote; on a
// conflict we log and report failure rather than clobbering another design.
export async function linkDesignToQuote(id: string, quoteId: string): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb.from('designs').update({ quote_id: quoteId }).eq('id', id);
  if (error) {
    console.error('Supabase linkDesignToQuote error:', error);
    return false;
  }
  return true;
}

// Decode a base64 image, store it in the private bucket, measure it with sharp,
// and record the path + dimensions on the row. Returns the stored metadata.
export async function uploadDesignPhoto(
  id: string,
  base64: string,
  contentType: string,
): Promise<{ path: string; width: number; height: number }> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase service role not configured');

  // Accept both raw base64 and a full `data:` URI.
  const comma = base64.indexOf(',');
  const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
  const buf = Buffer.from(raw, 'base64');

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const path = `${id}/photo.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType,
    upsert: true,
  });
  if (upErr) throw new Error(`uploadDesignPhoto: ${upErr.message}`);

  const { error: rowErr } = await sb
    .from('designs')
    .update({ photo_path: path, photo_w: width, photo_h: height })
    .eq('id', id);
  if (rowErr) throw new Error(`uploadDesignPhoto (row): ${rowErr.message}`);

  return { path, width, height };
}
