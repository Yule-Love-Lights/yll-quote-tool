import sharp from 'sharp';
import { getSupabaseServiceClient } from './supabase';
import type { Scene } from './design/sceneTypes';
import { pruneOrphanedMiniGroups, isMiniGroup } from './design/sceneTypes';
import { seedLinesHaveContent, type RooflineSeedLines } from './design/seedRoofline';
import {
  seedSceneFromAnalysis,
  analysisSeedHasContent,
  countSeededGarlandUnestimated,
  makeDefaultYardstick,
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
  // Stake Lighting satellite runs — own channel, parallel to c9 (Winter
  // Wonderland). Optional so designs saved before Stake Lighting still load.
  stake?: { points: [number, number][]; label: string }[];
  // Permanent Lighting (#88 / S23): the four house-side rooflines traced on the
  // satellite view — permanent bills from these and the portal draws them.
  // Optional so pre-permanent (holiday/event) designs still load unchanged.
  front?: { points: [number, number][]; label: string }[];
  left?: { points: [number, number][]; label: string }[];
  right?: { points: [number, number][]; label: string }[];
  back?: { points: [number, number][]; label: string }[];
  // Permanent Bistro Lighting (#117): freeform bistro-run polylines traced on
  // the satellite view — permanent_bistro bills from these (true-scale
  // feet-per-pixel, no yardstick) and the portal draws them. Optional so
  // pre-#117 designs still load unchanged. `id` is the run's stable id (#117
  // MED) — persisted so a reopened quote rehydrates it and #104 per-line
  // overrides keep following the right run across edits.
  bistro?: { points: [number, number][]; label: string; id?: string }[];
  santasFootage?: number;
  gingerbreadFootage?: number;
};

// One EXTRA street photo on a design (#13 multi-image). The base photo stays
// photo_path/photo_w/photo_h; extras are additional angles staff draw on
// (scene items reference them via `photoId`). Stored under the design's own
// storage prefix (`{designId}/extra-<id>.<ext>`) so deleteDesign's
// prefix-removal + the retention purge cover them with no changes.
export type DesignExtraPhoto = {
  id: string;
  path: string;
  w: number;
  h: number;
  title?: string | null;
  // Who put this photo here. Absent (the default, and every row written before
  // 2026-07-22) means an operator added it as part of the design, so it stays
  // customer-visible. 'crew' marks an INTERNAL field photo — the text-ops bot's
  // install capture — which the customer portal must never render: a ladder,
  // a half-finished install, or a crew member's face has no business appearing
  // in the homeowner's gallery. Filtered in portalPhotos(); staff surfaces read
  // design.extraPhotos directly and still see it, which is the point.
  source?: 'crew' | null;
  // The Telegram file id this photo came from (bot install capture only). Lets
  // addDesignExtraPhoto dedupe by source file so a retry or a redelivered
  // webhook can't append the same shot twice. Absent on operator uploads.
  telegramFileId?: string | null;
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
  // Extra street photos (#13). Nullable — pre-migration rows have null.
  extra_photos?: DesignExtraPhoto[] | null;
  // Staff title for the BASE photo (#13) — null renders as "Photo 1".
  photo_title?: string | null;
  // Customer-portal presentation controls. Staff reads still return every
  // artifact so a hidden image can be edited or shown again later.
  portal_show_street_view: boolean;
  portal_show_satellite_view: boolean;
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
  // Top-down satellite roof view (#51) — a freshly-signed URL for the private
  // satellite image plus its dims + the red/blue/green roofline polylines
  // (normalized 0–1). All nullable: designs without a satellite (manual upload /
  // pre-migration / never-Calculated) carry nulls and the portal hides the view.
  satelliteUrl: string | null;
  satelliteW: number | null;
  satelliteH: number | null;
  // #142: the Google-pull scale (ft/px) — the builder needs it to rehydrate a
  // reopened permanent quote's satellite measurement (null for manual uploads).
  satelliteFeetPerPixel: number | null;
  satelliteLines: DesignSatelliteLines | null;
  // Extra street photos (#13), each with a freshly-signed URL. Empty array for
  // designs without extras (incl. every pre-migration design). `source: 'crew'`
  // marks an INTERNAL field photo (the text-ops bot's install capture) that
  // portalPhotos() must filter from the customer gallery — it MUST survive this
  // read or the filter runs against undefined and shows crew photos to homeowners.
  extraPhotos: {
    id: string;
    url: string | null;
    w: number;
    h: number;
    title: string | null;
    source?: 'crew' | null;
  }[];
  // Staff title for the base photo (#13) — null renders as "Photo 1".
  photoTitle: string | null;
  // Raw-path availability, independent of signed-URL success. Staff controls
  // use these so a transient signing failure cannot strand a hidden image.
  hasStreetImage: boolean;
  hasSatelliteImage: boolean;
  portalShowStreetView: boolean;
  portalShowSatelliteView: boolean;
};

export type DesignPortalVisibility = Pick<
  DesignWithPhoto,
  'portalShowStreetView' | 'portalShowSatelliteView'
>;

const BUCKET = 'designs';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Cap the decoded image size before sharp() touches it (audit fix, finding #22).
// Without this an oversized/compression-bomb base64 body would be decoded into an
// unbounded Buffer and handed to sharp(), exhausting memory/CPU. Mirrors the 10MB
// MAX_BYTES enforced by /api/uploads.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// W2-029: a real UUID shape (8-4-4-4-12 hex groups), not just "36 chars of hex
// or dash" — the old regex accepted malformed ids like 36 dashes. Matches the
// strict pattern already used elsewhere (portal/loader.ts, dashboard/inbox/validate.ts).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidDesignId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function getSb() {
  // Service-role only — the bucket is private and the service role bypasses RLS
  // (enabled on designs with no policies, #90).
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
  /**
   * #88 permanent: seed a DEFAULT (uncalibrated) scale yardstick — permanent has
   * no analyzer to derive real px/ft, so the operator sizes it by hand (parity
   * with the holiday auto-yardstick, minus the AI calibration). Ignored when an
   * analysis seed is present (that path seeds its own calibrated yardstick).
   */
  seedDefaultYardstick?: boolean;
  /** Actor audit trail (#90): the operator's Supabase user id, or null. */
  createdBy?: string | null;
}): Promise<{ id: string; garlandSectionsUnestimated: number; seedFailed: boolean } | null> {
  const sb = getSb();
  if (!sb) return null;

  const { data, error } = await sb
    .from('designs')
    .insert({
      quote_id: opts.quoteId ?? null,
      scene: newDesignScene(),
      created_by: opts.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) {
    console.error('Supabase createDesign error:', error);
    return null;
  }
  const id = data.id as string;

  // Seed the base photo if one was supplied with the create call.
  let garlandSectionsUnestimated = 0;
  // W2-030: the create-row → upload-photo → seed-scene sequence is deliberately
  // best-effort (a failed seed doesn't fail the whole design — see the catch
  // below), but swallowing the error entirely hid a real partial state: the row
  // exists, the photo may or may not have uploaded, and the scene may still be
  // empty. Surface it via `seedFailed` so the caller (the builder) can tell
  // staff to re-upload / re-sync instead of silently shipping a blank canvas.
  let seedFailed = false;
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
        // #90: surface garland runs seeded with no scale so the builder can warn
        // staff to set their section counts (silent fallback to 1 = under-bill).
        garlandSectionsUnestimated = countSeededGarlandUnestimated(seed, scene, photo.width, photo.height);
      } else if (opts.seedDefaultYardstick && photo.width > 0 && photo.height > 0) {
        // #88 permanent: no analysis seed, so drop a default (uncalibrated) 5 ft
        // yardstick the operator sizes by hand — the design is born with a
        // yardstick instead of an empty canvas (parity with holiday's pull).
        const scene: DesignScene = {
          ...newDesignScene(),
          yardsticks: [makeDefaultYardstick(photo.width, photo.height)],
        };
        await updateDesignScene(id, scene);
      }
    } catch (err) {
      // A failed photo/roofline seed isn't fatal — the design still exists and
      // the operator can upload a photo / sync the roofline from the builder.
      // It's still a real partial state, so it's reported via seedFailed
      // rather than swallowed outright.
      console.error('createDesign: photo/roofline seed failed:', err);
      seedFailed = true;
    }
  }
  return { id, garlandSectionsUnestimated, seedFailed };
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

// W4-033: the exact columns toDesignWithPhoto reads — used by getDesignWithPhoto
// (the editor GET) and getDesignByQuote (the portal/quote-page load, hit on
// EVERY portal open). Deliberately excludes seed_analysis (the full raw AI
// jsonb), created_at, updated_at — none of which toDesignWithPhoto or
// DesignWithPhoto ever touch. satellite_feet_per_pixel joined the list for #142
// (the builder rehydrates a reopened permanent quote's satellite scale — one
// numeric column, negligible on the portal read). getDesign's own select('*')
// stays as-is: it's shared by staff/training paths that DO need seed_analysis
// (trainingExamples.ts captureTrainingExample, the seed-roofline/seed-analysis
// routes) and narrowing it would regress those.
const DESIGN_WITH_PHOTO_COLUMNS =
  'id, quote_id, scene, photo_path, photo_w, photo_h, satellite_path, satellite_w, satellite_h, satellite_feet_per_pixel, satellite_lines, extra_photos, photo_title, portal_show_street_view, portal_show_satellite_view';

type DesignWithPhotoRow = Pick<
  DesignRow,
  | 'id'
  | 'quote_id'
  | 'scene'
  | 'photo_path'
  | 'photo_w'
  | 'photo_h'
  | 'satellite_path'
  | 'satellite_w'
  | 'satellite_h'
  | 'satellite_feet_per_pixel'
  | 'satellite_lines'
  | 'extra_photos'
  | 'photo_title'
  | 'portal_show_street_view'
  | 'portal_show_satellite_view'
>;

// Attach a signed URL for the base photo (+ satellite + extras) to an
// already-loaded row — the shape the editor mounts from. Factored out of
// getDesignWithPhoto so callers that already have the row (getDesignByQuote,
// W2-031) don't need a second select by id.
async function toDesignWithPhoto(row: DesignWithPhotoRow): Promise<DesignWithPhoto> {
  // Sign the base photo and the satellite image in parallel (both private-bucket
  // paths; signDesignPhoto returns null for a missing path or on any failure).
  const extras = row.extra_photos ?? [];
  const [photoUrl, satelliteUrl, ...extraUrls] = await Promise.all([
    signDesignPhoto(row.photo_path),
    signDesignPhoto(row.satellite_path ?? null),
    ...extras.map(p => signDesignPhoto(p.path)),
  ]);
  return {
    id: row.id,
    quoteId: row.quote_id,
    scene: row.scene ?? EMPTY_SCENE,
    photoUrl,
    photoW: row.photo_w,
    photoH: row.photo_h,
    satelliteUrl,
    satelliteW: row.satellite_w ?? null,
    satelliteH: row.satellite_h ?? null,
    satelliteFeetPerPixel: row.satellite_feet_per_pixel ?? null,
    satelliteLines: row.satellite_lines ?? null,
    extraPhotos: extras.map((p, i) => ({
      id: p.id,
      url: extraUrls[i] ?? null,
      w: p.w,
      h: p.h,
      title: p.title ?? null,
      // Carry the internal-photo marker through: portalPhotos() filters on it to
      // keep crew install photos out of the customer gallery. Dropping it here
      // (the original bug) left every source undefined and the filter dead.
      source: p.source ?? null,
    })),
    photoTitle: row.photo_title ?? null,
    hasStreetImage:
      !!row.photo_path || extras.some((photo) => photo.source !== 'crew' && !!photo.path),
    hasSatelliteImage: !!row.satellite_path,
    portalShowStreetView: row.portal_show_street_view ?? true,
    portalShowSatelliteView: row.portal_show_satellite_view ?? true,
  };
}

// Load a design and attach a signed URL for its base photo — the shape the
// editor mounts from. W4-033: its own narrowed select (DESIGN_WITH_PHOTO_COLUMNS)
// instead of routing through getDesign's select('*') — this is the read hit on
// every editor open / portal render, and it never needs seed_analysis.
export async function getDesignWithPhoto(id: string): Promise<DesignWithPhoto | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('designs')
    .select(DESIGN_WITH_PHOTO_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase getDesignWithPhoto error:', error);
    return null;
  }
  if (!data) return null;
  return toDesignWithPhoto(data as unknown as DesignWithPhotoRow);
}

// The design linked to a given quote, if any (used when re-opening a quote
// that already has a design, incl. every portal open — loadPortalQuote calls
// this on the customer-facing path). W2-031: one query by quote_id instead of
// select('id') followed by getDesignWithPhoto's own second query by id.
// W4-033: narrowed to DESIGN_WITH_PHOTO_COLUMNS — the portal never needs the
// raw seed_analysis jsonb this used to pull on every open.
export async function getDesignByQuote(quoteId: string): Promise<DesignWithPhoto | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('designs')
    .select(DESIGN_WITH_PHOTO_COLUMNS)
    .eq('quote_id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('Supabase getDesignByQuote error:', error);
    return null;
  }
  if (!data) return null;
  return toDesignWithPhoto(data as unknown as DesignWithPhotoRow);
}

export type SampleDesign = {
  quoteId: string | null;
  scene: DesignScene;
  photoUrl: string;
  photoW: number | null;
  photoH: number | null;
};

/**
 * Recent REAL designed jobs to feature on the public self-serve estimate landing
 * (ledger self-serve, S48). Non-test, HOLIDAY, STAFF-SENT quotes (sent/viewed/
 * approved/booked/changes_requested — never a raw draft) that have a base photo + a
 * drawn scene — the ACTUAL designs staff traced, so they render (via DesignCanvas)
 * exactly like the portal, not a fabricated overlay on a stock photo. Best-effort:
 * returns [] on any failure. The payload is the house render only (no name/address/
 * PII). This marketing gallery intentionally remains independent of the
 * per-quote image controls; customer quote payloads and the self-serve design
 * poller enforce those controls separately.
 *
 * Two plain queries rather than a PostgREST foreign-key embed: the designs/quotes
 * schema is RLS-disabled and may not declare the FK the embed needs, which would
 * error the whole call. The status floor is a PRIVACY gate, not just quality:
 * /api/estimate auto-creates a draft for any visitor, so only staff-sent quotes may
 * be featured publicly (a self-serve draft becomes eligible only once staff send it).
 */
export async function listSampleDesigns(limit = 6): Promise<SampleDesign[]> {
  const sb = getSb();
  if (!sb) return [];
  // 1) Recent designs that actually have a base photo (a decent-sized pool).
  const { data: designRows, error: dErr } = await sb
    .from('designs')
    .select(DESIGN_WITH_PHOTO_COLUMNS)
    .not('photo_path', 'is', null)
    .not('quote_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(limit * 8);
  if (dErr) {
    console.error('Supabase listSampleDesigns designs error:', dErr);
    return [];
  }
  const rows = (designRows ?? []) as unknown as DesignWithPhotoRow[];
  if (rows.length === 0) return [];

  // 2) The quotes those designs belong to — to drop test + dead (declined/lost/
  //    cancelled) quotes without an FK embed.
  const quoteIds = Array.from(new Set(rows.map((r) => r.quote_id).filter((v): v is string => !!v)));
  const { data: quoteRows, error: qErr } = await sb
    .from('quotes')
    .select('id, is_test, status, service_type')
    .in('id', quoteIds);
  if (qErr) {
    console.error('Supabase listSampleDesigns quotes error:', qErr);
    return [];
  }
  // PRIVACY: only quotes STAFF actually sent to a real customer — never a raw
  // 'draft'. /api/estimate auto-creates a draft + design for ANYONE who types an
  // address, so a "non-dead" filter would put a random visitor's (or an unsent
  // internal) home on the public marketing gallery. A self-serve quote qualifies
  // only once staff review it and send it.
  const SENT_PLUS = new Set(['sent', 'viewed', 'approved', 'booked', 'changes_requested']);
  const showable = new Set<string>();
  for (const q of (quoteRows ?? []) as Array<{ id: string; is_test: boolean | null; status: string | null; service_type: string | null }>) {
    // HOLIDAY (Christmas) only — exclude permanent / event / bistro. A NULL
    // service_type reads as 'holiday' (the DB default), so include it.
    const isHoliday = q.service_type === 'holiday' || q.service_type == null;
    if (!q.is_test && isHoliday && q.status != null && SENT_PLUS.has(q.status)) showable.add(q.id);
  }

  // 3) Keep good designs (photo + a non-empty scene) of real, live quotes — recent
  //    first. Check the scene before signing so we only sign the ones we'll show.
  const usable: SampleDesign[] = [];
  for (const r of rows) {
    if (!r.quote_id || !showable.has(r.quote_id)) continue;
    const scene = (r.scene ?? EMPTY_SCENE) as DesignScene;
    if (!Array.isArray(scene.items) || scene.items.length === 0) continue;
    const d = await toDesignWithPhoto(r);
    if (!d.photoUrl) continue;
    usable.push({ quoteId: d.quoteId, scene: d.scene, photoUrl: d.photoUrl, photoW: d.photoW, photoH: d.photoH });
    if (usable.length >= limit) break;
  }
  return usable;
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

// Customer-portal presentation flags. Build the update from only the supplied
// keys so two staff tabs changing different toggles cannot stale-overwrite one
// another. Return the row's canonical pair for the client to reconcile.
export async function updateDesignPortalVisibility(
  id: string,
  patch: Partial<DesignPortalVisibility>,
): Promise<DesignPortalVisibility | null> {
  const sb = getSb();
  if (!sb) return null;

  const update: Record<string, boolean> = {};
  if (patch.portalShowStreetView !== undefined) {
    update.portal_show_street_view = patch.portalShowStreetView;
  }
  if (patch.portalShowSatelliteView !== undefined) {
    update.portal_show_satellite_view = patch.portalShowSatelliteView;
  }
  if (Object.keys(update).length === 0) return null;

  const { data, error } = await sb
    .from('designs')
    .update(update)
    .eq('id', id)
    .select('portal_show_street_view, portal_show_satellite_view')
    .maybeSingle<{
      portal_show_street_view: boolean;
      portal_show_satellite_view: boolean;
    }>();
  if (error || !data) {
    console.error('Supabase updateDesignPortalVisibility error:', error ?? 'Design not found');
    return null;
  }
  return {
    portalShowStreetView: data.portal_show_street_view,
    portalShowSatelliteView: data.portal_show_satellite_view,
  };
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

// Clone the design linked to `sourceQuoteId` into a fresh, INDEPENDENT design
// linked to `newQuoteId` (ledger #83 Phase 5 "rebook last season"). Copies the
// scene jsonb + the satellite measurement context, and server-side-copies the
// base photo + satellite image (+ every extra street photo, #13 multi-image)
// to the new design's `{newId}/` storage prefix so the clone owns its OWN
// bucket objects (sharing paths would let deleting one quote erase the
// other's photos via deleteDesign). Returns the new design id, or null when
// the source has no design / Supabase isn't configured. Storage copy is
// best-effort: a failed copy leaves the artifact NULL (base/satellite) or
// drops just that entry (extras) — staff re-pull the photo — rather than
// dangerously sharing the source path.
//
// W2-001/013: extra_photos MUST carry over. The scene jsonb is copied
// verbatim and its items reference extras via photoId (sceneTypes.ts
// `photoId`, matched by an extra's `id` — NOT its storage path), so as long
// as each surviving extra keeps its original `id` and gets a remapped `path`
// under the new prefix, the scene's photoId references stay valid on the
// clone with no scene rewrite needed.
export async function cloneDesignToNewQuote(
  sourceQuoteId: string,
  newQuoteId: string,
  // Actor audit trail (#90): the operator's Supabase user id, or null. W2-032:
  // carried like createDesign/saveQuote stamp on every other creation path.
  createdBy: string | null = null,
): Promise<{ id: string } | null> {
  const sb = getSb();
  if (!sb) return null;

  const { data: srcData, error: selErr } = await sb
    .from('designs')
    .select('*')
    .eq('quote_id', sourceQuoteId)
    .maybeSingle();
  if (selErr) {
    console.error('cloneDesignToNewQuote (source) error:', selErr);
    return null;
  }
  if (!srcData) return null; // nothing to clone — the source quote had no design
  const src = srcData as DesignRow;

  const { data: created, error: insErr } = await sb
    .from('designs')
    .insert({
      quote_id: newQuoteId,
      scene: src.scene ?? newDesignScene(),
      created_by: createdBy ?? null,
      // Visibility is per quote. A rebook starts visible even when staff hid
      // imagery on the old quote.
      portal_show_street_view: true,
      portal_show_satellite_view: true,
    })
    .select('id')
    .single();
  if (insErr || !created) {
    console.error('cloneDesignToNewQuote (insert) error:', insErr);
    return null;
  }
  const newId = created.id as string;

  // Server-side copy every object under the source prefix to the new prefix.
  // Track each extra's NEW path by its old path so we can rebuild extra_photos
  // below without guessing filenames back from the id.
  let photoPath: string | null = null;
  let satellitePath: string | null = null;
  const copiedExtraPathByOld = new Map<string, string>();
  try {
    const { data: objects, error: listErr } = await sb.storage.from(BUCKET).list(src.id);
    if (listErr) {
      console.error('cloneDesignToNewQuote (list) error:', listErr);
    } else {
      for (const o of objects ?? []) {
        const from = `${src.id}/${o.name}`;
        const to = `${newId}/${o.name}`;
        const { error: cpErr } = await sb.storage.from(BUCKET).copy(from, to);
        if (cpErr) {
          console.error('cloneDesignToNewQuote (copy) error:', cpErr);
          continue;
        }
        if (o.name.startsWith('photo.')) photoPath = to;
        if (o.name.startsWith('satellite.')) satellitePath = to;
        copiedExtraPathByOld.set(from, to);
      }
    }
  } catch (err) {
    console.error('cloneDesignToNewQuote (storage) threw:', err);
  }

  // Rebuild extra_photos from the source array, remapping each entry's path
  // from the src.id prefix to the newId prefix. Keep ONLY entries whose blob
  // copy actually succeeded (mirrors the null-on-failed-copy discipline used
  // for photo_path/satellite_path above) — a dropped extra never leaves a
  // dangling/mismatched row entry pointing at an uncopied object.
  const extraPhotos: DesignExtraPhoto[] = (src.extra_photos ?? []).flatMap((p) => {
    const newPath = copiedExtraPathByOld.get(p.path);
    return newPath ? [{ ...p, path: newPath }] : [];
  });

  // Point the new row at the COPIED artifacts (null when a copy failed — never
  // the source path) + carry the jsonb measurement context (satellite lines +
  // analysis are in-row, always safe to copy).
  const { error: updErr } = await sb
    .from('designs')
    .update({
      photo_path: photoPath,
      photo_w: photoPath ? src.photo_w : null,
      photo_h: photoPath ? src.photo_h : null,
      photo_title: src.photo_title ?? null,
      satellite_path: satellitePath,
      satellite_w: satellitePath ? src.satellite_w ?? null : null,
      satellite_h: satellitePath ? src.satellite_h ?? null : null,
      satellite_feet_per_pixel: satellitePath ? src.satellite_feet_per_pixel ?? null : null,
      satellite_lines: src.satellite_lines ?? null,
      seed_analysis: src.seed_analysis ?? null,
      extra_photos: extraPhotos,
    })
    .eq('id', newId);
  if (updErr) {
    console.error('cloneDesignToNewQuote (row update) error:', updErr);
  }
  return { id: newId };
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
  // Audit fix (#22): bound the decoded size before sharp() runs.
  if (rawBuf.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 10MB)');
  const { buf, contentType: storedType, ext } = await normalizeImage(rawBuf, contentType);

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // W2-014: read the CURRENT satellite_path before overwriting — upsert only
  // replaces the identical storage key, so a replacement with a different
  // extension (e.g. satellite.png → satellite.jpg) would otherwise leave the
  // old blob dangling under the design's prefix until the whole design is
  // deleted.
  const { data: prevRow, error: prevErr } = await sb
    .from('designs')
    .select('satellite_path')
    .eq('id', id)
    .maybeSingle();
  if (prevErr) console.error('uploadDesignSatellite (prev read):', prevErr);
  const prevPath = (prevRow as { satellite_path?: string | null } | null)?.satellite_path ?? null;

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

  // Clean up the orphaned old blob (best-effort, non-fatal) when the
  // extension changed — upsert already handled the same-extension case.
  if (prevPath && prevPath !== path) {
    const { error: rmErr } = await sb.storage.from(BUCKET).remove([prevPath]);
    if (rmErr) console.error('uploadDesignSatellite (old blob remove):', rmErr);
  }

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

// ─── Retention / erasure (audit fix: customer-photo-retention-deletion) ─────
// Before this, there was NO storage-cleanup path: deleting a quote left the
// design row (quote_id reset to NULL by the FK's `on delete set null`) and its
// base house photo + satellite image in the private `designs` bucket forever —
// indefinite PII retention. deleteDesign() removes BOTH the row and every
// object under the design's `{id}/` storage prefix (photo.<ext>, satellite.<ext>,
// any future per-design artifacts). Training-example capture already snapshots
// design images INTO the example row (see downloadDesignImageBase64), so erasing
// a design's bucket objects does not destroy captured training data.

// Hard-delete a single design: remove all bucket objects under `{id}/`, then the
// row. Returns false if Supabase isn't configured. Storage removal is best-effort
// (logged, non-fatal) so a transient storage error never blocks the row delete —
// but the row delete itself surfaces via the boolean.
export async function deleteDesign(id: string): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;

  // List then remove everything under the design's storage prefix. Listing
  // (rather than hard-coding photo.*/satellite.*) cleans up regardless of which
  // extension was stored and survives future artifact types.
  try {
    const { data: objects, error: listErr } = await sb.storage.from(BUCKET).list(id);
    if (listErr) {
      console.error('deleteDesign: storage list failed:', listErr);
    } else if (objects && objects.length) {
      const paths = objects.map((o) => `${id}/${o.name}`);
      const { error: rmErr } = await sb.storage.from(BUCKET).remove(paths);
      if (rmErr) console.error('deleteDesign: storage remove failed:', rmErr);
    }
  } catch (err) {
    // Non-fatal: still delete the row so the PII-bearing record is gone even if
    // the bucket op throws. Orphaned objects can be swept later.
    console.error('deleteDesign: storage cleanup threw:', err);
  }

  const { error } = await sb.from('designs').delete().eq('id', id);
  if (error) {
    console.error('Supabase deleteDesign error:', error);
    return false;
  }
  return true;
}

// Erase every design linked to a given quote (the cascade deleteQuote needs so a
// quote delete no longer orphans the design + its private images). At most one
// design is linked per quote today (partial unique index), but this handles N
// defensively. Returns the count of designs deleted.
export async function deleteDesignsForQuote(quoteId: string): Promise<number> {
  const sb = getSb();
  if (!sb) return 0;
  const { data, error } = await sb.from('designs').select('id').eq('quote_id', quoteId);
  if (error) {
    console.error('Supabase deleteDesignsForQuote (lookup) error:', error);
    return 0;
  }
  const ids = (data ?? []).map((r) => r.id as string);
  // W2-034: designs are mutually independent (each's cleanup is its own row +
  // storage-prefix delete), so nothing forces strictly-serial one-at-a-time
  // deletion. Bounded-concurrency chunks (mirrors customers.ts
  // backfillCustomersFromQuotes) instead of an unbounded Promise.all fan-out.
  const DELETE_CHUNK_SIZE = 8;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    const results = await Promise.all(chunk.map((id) => deleteDesign(id)));
    deleted += results.filter(Boolean).length;
  }
  return deleted;
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
  // Audit fix (#22): bound the decoded size before sharp() runs.
  if (rawBuf.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 10MB)');
  const { buf, contentType: storedType, ext } = await normalizeImage(rawBuf, contentType);

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // W2-014: read the CURRENT photo_path before overwriting — see the matching
  // comment in uploadDesignSatellite for why this is needed.
  const { data: prevRow, error: prevErr } = await sb
    .from('designs')
    .select('photo_path')
    .eq('id', id)
    .maybeSingle();
  if (prevErr) console.error('uploadDesignPhoto (prev read):', prevErr);
  const prevPath = (prevRow as { photo_path?: string | null } | null)?.photo_path ?? null;

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

  // Clean up the orphaned old blob (best-effort, non-fatal) when the
  // extension changed — upsert already handled the same-extension case.
  if (prevPath && prevPath !== path) {
    const { error: rmErr } = await sb.storage.from(BUCKET).remove([prevPath]);
    if (rmErr) console.error('uploadDesignPhoto (old blob remove):', rmErr);
  }

  return { path, width, height };
}

// ─── Extra street photos (#13 multi-image) ──────────────────────────────────
// Additional angles of the same house on the ONE design. Scene items reference
// an extra via `photoId` (absent = the base photo). Extras are manual-only (no
// AI analyze) and carry no measurement — footage stays a base-photo/satellite
// concern.

// Read the current extras array (null-safe).
async function getExtraPhotos(sb: NonNullable<ReturnType<typeof getSb>>, id: string): Promise<DesignExtraPhoto[]> {
  const { data, error } = await sb.from('designs').select('extra_photos').eq('id', id).maybeSingle();
  if (error) throw new Error(`extra_photos read: ${error.message}`);
  if (!data) throw new Error('Design not found');
  return ((data as { extra_photos?: DesignExtraPhoto[] | null }).extra_photos ?? []);
}

// W2-015: extra_photos is a read-modify-write on a jsonb array with no atomic
// append primitive available from supabase-js (a real Postgres RPC would be
// the fully-atomic fix, but that needs a migration — out of scope here). This
// closes the race with an optimistic-concurrency guard instead: read
// extra_photos + updated_at together, compute the new array, then write it
// back CONDITIONED on updated_at still matching the snapshot (the designs
// table bumps updated_at via a trigger on every write, so any interleaving
// writer — another addDesignExtraPhoto, a title rename, a removal — changes
// it). If the guarded update matches zero rows, another writer won the race;
// retry from a fresh read (bounded) instead of silently losing the change.
const MAX_EXTRA_PHOTOS_RETRIES = 5;

async function updateExtraPhotosAtomic(
  sb: NonNullable<ReturnType<typeof getSb>>,
  id: string,
  compute: (current: DesignExtraPhoto[]) => DesignExtraPhoto[],
): Promise<DesignExtraPhoto[]> {
  for (let attempt = 0; attempt < MAX_EXTRA_PHOTOS_RETRIES; attempt++) {
    const { data, error } = await sb
      .from('designs')
      .select('extra_photos, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`extra_photos read: ${error.message}`);
    if (!data) throw new Error('Design not found');
    const row = data as { extra_photos?: DesignExtraPhoto[] | null; updated_at?: string };
    const current = row.extra_photos ?? [];
    const next = compute(current);

    const { data: updated, error: updErr } = await sb
      .from('designs')
      .update({ extra_photos: next })
      .eq('id', id)
      .eq('updated_at', row.updated_at)
      .select('id');
    if (updErr) throw new Error(`extra_photos write: ${updErr.message}`);
    // A non-empty result means our updated_at precondition matched — we won.
    // An empty result means another writer updated the row first; retry.
    if (Array.isArray(updated) && updated.length > 0) return next;
  }
  throw new Error('extra_photos write: too many concurrent-update retries');
}

// Decode + store one extra photo and append it to the design's extra_photos.
// Returns the stored entry (id is a fresh UUID — it's what scene items'
// `photoId` will reference).
//
// `source: 'crew'` marks an internal field photo that the customer portal must
// not render (see DesignExtraPhoto.source). Omitting it keeps the operator
// default: part of the design, shown to the customer.
export async function addDesignExtraPhoto(
  id: string,
  base64: string,
  contentType: string,
  title?: string | null,
  source?: 'crew' | null,
  telegramFileId?: string | null,
): Promise<DesignExtraPhoto> {
  const sb = getSb();
  if (!sb) throw new Error('Supabase service role not configured');

  const comma = base64.indexOf(',');
  const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
  const rawBuf = Buffer.from(raw, 'base64');
  // Audit fix (#22): bound the decoded size before sharp() runs.
  if (rawBuf.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 10MB)');
  const { buf, contentType: storedType, ext } = await normalizeImage(rawBuf, contentType);

  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const photoId = crypto.randomUUID();
  const path = `${id}/extra-${photoId}.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType: storedType,
    upsert: true,
  });
  if (upErr) throw new Error(`addDesignExtraPhoto: ${upErr.message}`);

  const entry: DesignExtraPhoto = {
    id: photoId,
    path,
    w: width,
    h: height,
    title: title?.trim() || null,
    ...(source === 'crew' ? { source: 'crew' as const } : {}),
    ...(telegramFileId ? { telegramFileId } : {}),
  };
  // W2-015: atomic (guarded-retry) append — see updateExtraPhotosAtomic. Dedupe
  // by Telegram file id INSIDE the atomic updater so a retry or a redelivered
  // webhook can't append the same install shot twice, even under a race.
  let deduped: DesignExtraPhoto | null = null;
  await updateExtraPhotosAtomic(sb, id, (current) => {
    if (telegramFileId) {
      const existing = current.find((p) => p.telegramFileId === telegramFileId);
      if (existing) {
        deduped = existing;
        return current;
      }
    }
    return [...current, entry];
  });

  if (deduped) {
    // Clean up the orphan object we just uploaded before discovering the dup.
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    return deduped;
  }
  return entry;
}

// #741 defect 3: what a mini group's stringCount/surface report as, for the
// staff-facing "these were removed" notice — mirrors the #255 seed-analysis
// route's identical shape so QuoteBuilder can render both with one message.
export type PrunedMiniGroupReport = { surface: string | null; stringCount: number };
type RemoveDesignExtraPhotoResult = { ok: boolean; prunedMiniGroups: PrunedMiniGroupReport[] };
const REMOVE_EXTRA_PHOTO_FAILED: RemoveDesignExtraPhotoResult = { ok: false, prunedMiniGroups: [] };

// Remove one extra photo: its storage object, its array entry, AND every scene
// item drawn on it (an item tagged to a deleted photo would otherwise be
// invisible everywhere, forever). PR2b's linked twins refine delete semantics;
// here any item with the matching photoId dies with its photo.
export async function removeDesignExtraPhoto(id: string, photoId: string): Promise<RemoveDesignExtraPhotoResult> {
  const sb = getSb();
  if (!sb) return REMOVE_EXTRA_PHOTO_FAILED;

  // W2-033: read extra_photos AND scene in the one row fetch (previously a
  // second getDesign('*') re-read the row just for the scene, below).
  let extras: DesignExtraPhoto[];
  let scene: DesignScene | undefined;
  try {
    const { data, error } = await sb.from('designs').select('extra_photos, scene').eq('id', id).maybeSingle();
    if (error) throw new Error(`extra_photos read: ${error.message}`);
    if (!data) throw new Error('Design not found');
    const row = data as { extra_photos?: DesignExtraPhoto[] | null; scene?: DesignScene | null };
    extras = row.extra_photos ?? [];
    scene = row.scene ?? undefined;
  } catch (err) {
    console.error('removeDesignExtraPhoto:', err);
    return REMOVE_EXTRA_PHOTO_FAILED;
  }
  const entry = extras.find(p => p.id === photoId);
  if (!entry) return REMOVE_EXTRA_PHOTO_FAILED;

  // Storage first (non-fatal on failure — the object is unreachable once the
  // entry is gone; deleteDesign's prefix-removal is the backstop).
  try {
    const { error: rmErr } = await sb.storage.from(BUCKET).remove([entry.path]);
    if (rmErr) console.error('removeDesignExtraPhoto: storage remove failed:', rmErr);
  } catch (err) {
    console.error('removeDesignExtraPhoto: storage remove threw:', err);
  }

  // Guarded-retry write (same as addDesignExtraPhoto) — closes the race where
  // a concurrent writer (another add, a title rename, a removal) lands between
  // this function's snapshot read above and a plain write, which would silently
  // drop the interleaved change. See updateExtraPhotosAtomic.
  try {
    await updateExtraPhotosAtomic(sb, id, (current) => current.filter(p => p.id !== photoId));
  } catch (err) {
    console.error('removeDesignExtraPhoto (row):', err);
    return REMOVE_EXTRA_PHOTO_FAILED;
  }

  // Prune scene items drawn on the removed photo — plus any linked twins of a
  // pruned CANONICAL (#13): a twin on another photo depicting an item that just
  // died with this photo would otherwise dangle (render-only, unlinked forever).
  //
  // W2-016: re-read the scene FRESH right here, immediately before the prune
  // write, instead of reusing the snapshot from the top of this function. The
  // editor autosaves the scene independently (updateDesignScene) — using the
  // stale initial-read snapshot would clobber a concurrent autosave that lands
  // in the gap between this function's start and its prune write. A fresh
  // read-then-write still has a (much smaller) window, matching the same
  // last-write-wins risk the rest of the scene-autosave path already accepts.
  let prunedMiniGroups: PrunedMiniGroupReport[] = [];
  try {
    const { data: freshData, error: freshErr } = await sb
      .from('designs')
      .select('scene')
      .eq('id', id)
      .maybeSingle();
    if (freshErr) throw new Error(`scene re-read: ${freshErr.message}`);
    const freshScene = (freshData as { scene?: DesignScene | null } | null)?.scene ?? scene;
    if (freshScene && Array.isArray(freshScene.items) && freshScene.items.some(it => it.photoId === photoId)) {
      const prunedIds = new Set(freshScene.items.filter(it => it.photoId === photoId).map(it => it.id));
      // #227: pruneOrphanedMiniGroups drops any miniGroup left with zero
      // surviving member strands by this photo delete (it would otherwise
      // render nothing, be unselectable in the editor, and keep billing
      // forever via projectScene).
      // #741 defect 3: that drop was previously silent server-side — diff the
      // miniGroups before/after (same technique the #255 seed-analysis route
      // uses) so the caller can tell staff what just got removed.
      const beforeGroups = freshScene.items.filter(isMiniGroup);
      const keptItems = pruneOrphanedMiniGroups(freshScene.items.filter(
        it => it.photoId !== photoId && !(it.linkedToId && prunedIds.has(it.linkedToId)),
      ));
      const afterGroupIds = new Set(keptItems.filter(isMiniGroup).map(g => g.id));
      prunedMiniGroups = beforeGroups
        .filter(g => !afterGroupIds.has(g.id))
        .map(g => ({ surface: g.surface ?? null, stringCount: g.stringCount ?? 1 }));
      await updateDesignScene(id, { ...freshScene, items: keptItems });
    }
  } catch (err) {
    console.error('removeDesignExtraPhoto: scene prune failed:', err);
  }

  return { ok: true, prunedMiniGroups };
}

// Rename the BASE photo (#13) — null/empty clears back to "Photo 1".
export async function updateDesignPhotoTitle(id: string, title: string | null): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb
    .from('designs')
    .update({ photo_title: title?.trim() || null })
    .eq('id', id);
  if (error) {
    console.error('updateDesignPhotoTitle:', error);
    return false;
  }
  return true;
}

// Rename an extra photo (null/empty clears the title → "Photo N" in UIs).
export async function updateDesignExtraPhotoTitle(
  id: string,
  photoId: string,
  title: string | null,
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  let extras: DesignExtraPhoto[];
  try {
    extras = await getExtraPhotos(sb, id);
  } catch (err) {
    console.error('updateDesignExtraPhotoTitle:', err);
    return false;
  }
  if (!extras.some(p => p.id === photoId)) return false;
  // Guarded-retry write (same as addDesignExtraPhoto) — see updateExtraPhotosAtomic.
  try {
    await updateExtraPhotosAtomic(sb, id, (current) =>
      current.map(p => (p.id === photoId ? { ...p, title: title?.trim() || null } : p)),
    );
  } catch (err) {
    console.error('updateDesignExtraPhotoTitle (row):', err);
    return false;
  }
  return true;
}
