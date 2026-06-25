import sharp from 'sharp';
import { getSupabaseServiceClient } from './supabase';
import type { Scene } from './design/sceneTypes';
import { seedLinesHaveContent, type RooflineSeedLines } from './design/seedRoofline';
import {
  seedSceneFromAnalysis,
  analysisSeedHasContent,
  type AnalysisSeed,
} from './design/seedFromAnalysis';

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

// Default starting brightness for a NEWLY-CREATED design (#67). The base photo
// lands pre-dimmed so the strung lights pop and staff don't lower it by hand on
// every quote. Scale is 0–100 where 50 = neutral (no tint) and lower = darker;
// render-readonly paints a dark overlay below 50. 20 = a deep dusk (Naldo's
// pick) so the strung lights really pop against the darkened house. Staff can
// still slider it up for a brighter look, or double-click the slider to reset
// to 50. TUNE the look by changing this one number.
// NOTE: brightness is a persisted scene field, so this also dims the portal's
// lit design render — which is the intended nighttime look (and matches what
// staff already did by hand). Only NEW designs are affected; existing ones keep
// whatever brightness they were saved with.
export const DEFAULT_DESIGN_BRIGHTNESS = 20;

// The seed scene a new design is created with: empty geometry + the dimmed
// default. Used ONLY at creation — the missing-scene fallbacks
// (getDesignWithPhoto, the re-seed routes) deliberately keep EMPTY_SCENE so an
// existing design is never force-dimmed. A factory (not a shared const) so each
// new design gets its OWN fresh arrays — no cross-design mutation hazard.
function newDesignScene(): DesignScene {
  return { yardsticks: [], items: [], brightness: DEFAULT_DESIGN_BRIGHTNESS };
}

// The staff-confirmed satellite measurement state (#8 Stage A). Lines are
// normalized 0–1 polylines in satellite-image space (the builder's shape);
// footages are the derived feet at push time so training capture doesn't
// have to re-run the scale math.
export type DesignSatelliteLines = {
  santas: { points: [number, number][]; label: string }[];
  gingerbread: { points: [number, number][]; label: string }[];
  c9: { points: [number, number][]; label: string }[];
  santasFootage?: number;
  gingerbreadFootage?: number;
};

export type DesignRow = {
  id: string;
  quote_id: string | null;
  photo_path: string | null;
  photo_w: number | null;
  photo_h: number | null;
  scene: DesignScene;
  created_at: string;
  updated_at: string;
  // Analysis provenance + satellite context (#8 Stage A). Nullable — designs
  // made before the migration / without an AI run simply have nulls.
  seed_analysis?: Record<string, unknown> | null;
  satellite_path?: string | null;
  satellite_w?: number | null;
  satellite_h?: number | null;
  satellite_feet_per_pixel?: number | null;
  satellite_lines?: DesignSatelliteLines | null;
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
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

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
  /** Roofline lines only — superseded by seedAnalysis (kept for back-compat). */
  seedLines?: RooflineSeedLines | null;
  /** Full bridge auto-design payload (#35 Phase 2): roofline lines + per-unit detections. */
  seedAnalysis?: AnalysisSeed | null;
}): Promise<{ id: string } | null> {
  const sb = getSb();
  if (!sb) return null;

  const { data, error } = await sb
    .from('designs')
    .insert({
      quote_id: opts.quoteId ?? null,
      scene: newDesignScene(),
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
      // Seeding needs the photo's pixel dimensions — only possible when a
      // photo came with the create call (everything is drawn on it). The full
      // analysis seed (#35 Phase 2) wins; bare seedLines is the legacy shape.
      const seed: AnalysisSeed | null =
        opts.seedAnalysis && analysisSeedHasContent(opts.seedAnalysis)
          ? opts.seedAnalysis
          : opts.seedLines && seedLinesHaveContent(opts.seedLines)
            ? { lines: opts.seedLines }
            : null;
      if (seed && photo.width > 0 && photo.height > 0) {
        const scene = seedSceneFromAnalysis(newDesignScene(), seed, photo.width, photo.height);
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

// Normalize an image buffer to a storage-safe type. Supabase + the analyzer
// only deal in jpeg/png/webp; anything else (gif, heic, bmp, …) is transcoded
// to JPEG so the stored bytes, the file extension, and the media-type we later
// hand Claude all AGREE. Returns the (possibly re-encoded) buffer + the
// canonical contentType + matching extension.
async function normalizeImage(
  buf: Buffer,
  contentType: string,
): Promise<{ buf: Buffer; contentType: string; ext: string }> {
  if (contentType === 'image/png') return { buf, contentType, ext: 'png' };
  if (contentType === 'image/webp') return { buf, contentType, ext: 'webp' };
  if (contentType === 'image/jpeg') return { buf, contentType, ext: 'jpg' };
  // Unsupported declared type — re-encode to JPEG so bytes match the label.
  const jpeg = await sharp(buf).jpeg().toBuffer();
  return { buf: jpeg, contentType: 'image/jpeg', ext: 'jpg' };
}

// ─── Analysis provenance (#8 Stage A) ──────────────────────────────────────
// The builder persists, per design: the AI's raw analysis, the satellite
// image (+ scale) it measured against, and the staff's final satellite
// polylines. Training-example capture assembles entirely from these — so a
// reopened quote can be captured without any client-side state.

// Store the raw PhotoAnalysisResult from the latest analyze. Opaque jsonb —
// the analyzer owns its shape.
export async function setDesignAnalysis(
  id: string,
  analysis: Record<string, unknown>,
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb.from('designs').update({ seed_analysis: analysis }).eq('id', id);
  if (error) {
    console.error('Supabase setDesignAnalysis error:', error);
    return false;
  }
  return true;
}

// Store the satellite image in the private bucket alongside the base photo,
// plus its dimensions and the deterministic feet-per-pixel scale (null for a
// manual upload — no known scale, layout-only training value).
export async function uploadDesignSatellite(
  id: string,
  base64: string,
  contentType: string,
  feetPerPixel: number | null,
): Promise<{ path: string; width: number; height: number }> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase service role not configured');

  const comma = base64.indexOf(',');
  const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
  const rawBuf = Buffer.from(raw, 'base64');
  const { buf, contentType: storedType, ext } = await normalizeImage(rawBuf, contentType);

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const path = `${id}/satellite.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType: storedType,
    upsert: true,
  });
  if (upErr) throw new Error(`uploadDesignSatellite: ${upErr.message}`);

  const { error: rowErr } = await sb
    .from('designs')
    .update({
      satellite_path: path,
      satellite_w: width,
      satellite_h: height,
      satellite_feet_per_pixel: feetPerPixel,
      // A new satellite image invalidates any previously-traced lines — clear
      // them so a captured training example can't overlay stale lines on the
      // new image (M4). Fresh lines arrive later via updateDesignSatelliteLines.
      satellite_lines: null,
    })
    .eq('id', id);
  if (rowErr) throw new Error(`uploadDesignSatellite (row): ${rowErr.message}`);

  return { path, width, height };
}

// Store the staff's current satellite measurement polylines (pushed by the
// builder at Calculate — the natural "measurement finalized" moment).
export async function updateDesignSatelliteLines(
  id: string,
  lines: DesignSatelliteLines,
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb.from('designs').update({ satellite_lines: lines }).eq('id', id);
  if (error) {
    console.error('Supabase updateDesignSatelliteLines error:', error);
    return false;
  }
  return true;
}

// Download a private-bucket object back to base64 (training capture snapshots
// the design's photos INTO the example row so it survives design deletion).
export async function downloadDesignImageBase64(
  path: string | null,
): Promise<{ base64: string; mediaType: string } | null> {
  if (!path) return null;
  const sb = getSb();
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    // Prefer the true stored content type (the Blob's own type); fall back to
    // the extension only if the storage layer didn't report one.
    const blobType = (data.type || '').toLowerCase();
    let mediaType =
      blobType === 'image/png' || blobType === 'image/webp' || blobType === 'image/jpeg'
        ? blobType
        : '';
    if (!mediaType) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    }
    return { base64: buf.toString('base64'), mediaType };
  } catch {
    return null;
  }
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
  const rawBuf = Buffer.from(raw, 'base64');
  const { buf, contentType: storedType, ext } = await normalizeImage(rawBuf, contentType);

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const path = `${id}/photo.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType: storedType,
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
