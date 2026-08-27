// Per-design endpoints (design-tool integration, Path B — task #27).
//
//   GET /api/designs/[id] — load a design (scene + signed base-photo URL).
//   PUT /api/designs/[id] — update the scene (autosave), link the design to a
//                            quote, and/or store the staff's final satellite
//                            measurement lines ({ scene?, quoteId?,
//                            satelliteLines?, portalShowStreetView?,
//                            portalShowSatelliteView? } — #8 Stage A).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { appendQuoteAuditEntry } from '@/lib/quoteAudit';
import {
  getDesignWithPhoto,
  updateDesignSceneGuarded,
  linkDesignToQuote,
  updateDesignSatelliteLines,
  updateDesignPortalVisibility,
  isValidDesignId,
  type DesignScene,
  type DesignSatelliteLines,
  type DesignPortalVisibility,
} from '@/lib/designs';
import { clampBrightness } from '@/lib/design/photoBrightness';
import { SCENE_LOCKED_CODE, SCENE_LOCKED_MESSAGE } from '@/lib/design/sceneFreeze';

export const runtime = 'nodejs';

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

function isSceneShape(v: unknown): v is DesignScene {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as Record<string, unknown>).items) &&
    Array.isArray((v as Record<string, unknown>).yardsticks)
  );
}

function isSatelliteLinesShape(v: unknown): v is DesignSatelliteLines {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // Every channel is checked ONLY when present (type-tolerant): holiday sends
  // santas/gingerbread/c9; permanent (#88/S23) sends front/left/right/back;
  // permanent bistro (#117) sends bistro; a client from before any of these
  // still validates. At least one line channel must be an array so a truly
  // empty/garbage body is still rejected.
  const optArr = (x: unknown) => x === undefined || Array.isArray(x);
  const channels = [o.santas, o.gingerbread, o.c9, o.stake, o.front, o.left, o.right, o.back, o.bistro];
  return channels.every(optArr) && channels.some((c) => Array.isArray(c));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }
  try {
    const design = await getDesignWithPhoto(id);
    if (!design) return NextResponse.json({ error: 'Design not found' }, { status: 404 });
    return NextResponse.json({ design });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lookup failed';
    console.error('GET /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { scene, quoteId, satelliteLines, version, portalShowStreetView, portalShowSatelliteView } =
    body;
  const hasStreetVisibility = Object.prototype.hasOwnProperty.call(body, 'portalShowStreetView');
  const hasSatelliteVisibility = Object.prototype.hasOwnProperty.call(body, 'portalShowSatelliteView');
  if (
    scene === undefined &&
    quoteId === undefined &&
    satelliteLines === undefined &&
    !hasStreetVisibility &&
    !hasSatelliteVisibility
  ) {
    return NextResponse.json(
      {
        error:
          'Nothing to update (provide scene, quoteId, satelliteLines, portalShowStreetView, and/or portalShowSatelliteView)',
      },
      { status: 400 },
    );
  }
  if (scene !== undefined && !isSceneShape(scene)) {
    return NextResponse.json({ error: 'scene must be an object with items[] and yardsticks[]' }, { status: 400 });
  }
  // Ledger row 260: version is the compare-and-swap precondition for `scene`
  // — omitted/null means the caller doesn't know it (an old cached bundle, or
  // a design never previously read) and updateDesignSceneGuarded adopts
  // rather than rejecting the request outright. Only checked when `scene` is
  // present — quoteId-only / satelliteLines-only PUTs touch different columns
  // and never race the scene guard.
  if (scene !== undefined && version !== undefined && version !== null && !(typeof version === 'number' && Number.isInteger(version))) {
    return NextResponse.json({ error: 'version must be an integer or null' }, { status: 400 });
  }
  if (quoteId !== undefined && !isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
  }
  if (satelliteLines !== undefined && !isSatelliteLinesShape(satelliteLines)) {
    return NextResponse.json(
      { error: 'satelliteLines must be an object with line arrays for at least one channel (santas/gingerbread/c9/stake, front/left/right/back, or bistro)' },
      { status: 400 },
    );
  }
  if (hasStreetVisibility && typeof portalShowStreetView !== 'boolean') {
    return NextResponse.json({ error: 'portalShowStreetView must be a boolean' }, { status: 400 });
  }
  if (hasSatelliteVisibility && typeof portalShowSatelliteView !== 'boolean') {
    return NextResponse.json({ error: 'portalShowSatelliteView must be a boolean' }, { status: 400 });
  }

  try {
    let portalVisibility: DesignPortalVisibility | null = null;
    let newVersion: number | undefined;
    if (scene !== undefined) {
      const rawScene = scene as DesignScene;
      const normalizedScene: DesignScene = {
        ...rawScene,
        ...(rawScene.brightness !== undefined
          ? { brightness: clampBrightness(rawScene.brightness) }
          : {}),
        // Row 348 fix round: the per-photo map must FILTER, not map-and-coerce.
        // `clampBrightness` returns 50 for anything non-numeric, which is right
        // for the scene-level field (brightnessForPhoto already defaults it with
        // `scene.brightness ?? 50`, so null -> 50 changes nothing) but WRONG per
        // photo: the lookup is `extraPhotoBrightness?.[photoId] ?? baseBrightness`,
        // so a null/garbage entry currently falls back to the SCENE's brightness,
        // not to 50. Mapping it through the clamp would silently pin that photo
        // at 50 and stop it inheriting — a visible tint change on every render
        // path, portal included, introduced by a guard meant to prevent exactly
        // that class of thing. Dropping the non-numeric entry preserves the
        // inherit-from-base behaviour exactly (a missing key reads the same as a
        // null one) and discards nothing real, since the value was never usable.
        ...(rawScene.extraPhotoBrightness
          ? {
              extraPhotoBrightness: Object.fromEntries(
                Object.entries(rawScene.extraPhotoBrightness)
                  .filter(([, b]) => typeof b === 'number' && Number.isFinite(b))
                  .map(([photoId, b]) => [photoId, clampBrightness(b)]),
              ),
            }
          : {}),
      };
      const outcome = await updateDesignSceneGuarded(id, normalizedScene, version as number | null | undefined);
      if (!outcome.ok) {
        // Row 367: the shared writer refused because the linked quote carries
        // a frozen (customer-approved) agreement. Distinguishable `code` so
        // the editor tells this apart from the row-260 CAS conflict below —
        // the conflict's remedy is "reload", which here would loop staff back
        // into the same lock.
        if (outcome.reason === 'locked') {
          return NextResponse.json(
            { error: SCENE_LOCKED_MESSAGE, code: SCENE_LOCKED_CODE },
            { status: 409 },
          );
        }
        // Row 367: the freeze state could not be READ. Not a lock (a transient
        // blip must not permanently block this editor, nor claim a live quote
        // is approved) and not a licence to write — a retryable 5xx keeps the
        // edit queued for the editor's own backoff retry.
        if (outcome.reason === 'unverified') {
          return NextResponse.json(
            { error: "Could not verify this design's approval state — not saved. Retrying." },
            { status: 500 },
          );
        }
        if (outcome.reason === 'conflict') {
          // Distinguishable body (`conflict: true`) so the editor can tell
          // this apart from an ordinary save failure and block-and-offer-
          // reload instead of silently retrying the same stale overwrite.
          return NextResponse.json(
            { error: 'This design changed elsewhere — reload to see the latest version', conflict: true },
            { status: 409 },
          );
        }
        return NextResponse.json({ error: 'Failed to save scene' }, { status: 500 });
      }
      newVersion = outcome.version;
    }
    if (quoteId !== undefined) {
      const ok = await linkDesignToQuote(id, quoteId as string);
      if (!ok) {
        return NextResponse.json(
          { error: 'Failed to link design to quote (it may already have a design)' },
          { status: 409 },
        );
      }
    }
    if (satelliteLines !== undefined) {
      const outcome = await updateDesignSatelliteLines(id, satelliteLines as DesignSatelliteLines);
      if (!outcome.ok) {
        // Row 427: `locked` here does NOT mean "this quote is approved" — an
        // approved quote's re-Calculate re-persists identical lines and is
        // allowed through. It means these lines actually DIFFER from the trace
        // the customer signed off on, which the portal renders.
        if (outcome.reason === 'locked') {
          return NextResponse.json(
            {
              error:
                'This satellite trace is locked — the customer already approved the roofline it shows, so it ' +
                'cannot be redrawn here. Re-calculating without changing the lines still works. To change the ' +
                'trace itself: decline this quote, revive it, edit, and re-send. (A booked order is changed ' +
                'through the amend flow.)',
              code: SCENE_LOCKED_CODE,
            },
            { status: 409 },
          );
        }
        if (outcome.reason === 'unverified') {
          return NextResponse.json(
            { error: "Could not verify this design's approval state — the satellite trace was not saved." },
            { status: 500 },
          );
        }
        return NextResponse.json({ error: 'Failed to save satellite lines' }, { status: 500 });
      }
    }
    if (hasStreetVisibility || hasSatelliteVisibility) {
      portalVisibility = await updateDesignPortalVisibility(id, {
        ...(hasStreetVisibility
          ? { portalShowStreetView: portalShowStreetView as boolean }
          : {}),
        ...(hasSatelliteVisibility
          ? { portalShowSatelliteView: portalShowSatelliteView as boolean }
          : {}),
      });
      if (!portalVisibility) {
        return NextResponse.json({ error: 'Failed to save portal visibility' }, { status: 500 });
      }
      // Row 370: record WHO hid/showed a portal image and when. The shared
      // updated_at trigger cannot distinguish this from any other design
      // write, and there was no paper trail if a customer disputed what was
      // shown. Best-effort by design (appendQuoteAuditEntry's contract):
      // the trail matters exactly for quotes with a FROZEN agreement — a
      // design with no linked quote, or a quote never approved (NULL
      // snapshot), has nothing agreed to dispute, and the helper's
      // unconfirmed-snapshot guard skips those rather than risking the
      // frozen agreement to record a presentational toggle.
      await recordVisibilityAudit(id, {
        ...(hasStreetVisibility ? { portalShowStreetView: portalShowStreetView as boolean } : {}),
        ...(hasSatelliteVisibility ? { portalShowSatelliteView: portalShowSatelliteView as boolean } : {}),
      });
    }
    return NextResponse.json({
      ok: true,
      ...(portalVisibility ?? {}),
      ...(newVersion !== undefined ? { version: newVersion } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed';
    console.error('PUT /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Row 370 — best-effort audit of a portal-visibility change, onto the linked
// quote's approval_snapshot (key: portalVisibilityChanges) via the shared
// hardened append (row 411). Never throws, never fails the caller's request:
// losing this audit line is acceptable; breaking a visibility save (or the
// frozen agreement) to record one is not.
async function recordVisibilityAudit(
  designId: string,
  changes: { portalShowStreetView?: boolean; portalShowSatelliteView?: boolean },
): Promise<void> {
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return;
    const { data: designRow, error: designErr } = await sb
      .from('designs')
      .select('quote_id')
      .eq('id', designId)
      .maybeSingle<{ quote_id: string | null }>();
    if (designErr) {
      // #976 lens MED: a REAL query error must leave a trace — this trail's
      // whole purpose is a dispute paper record, and a silently-failing read
      // would let it go dark with zero signal. The legitimate no-op (an
      // unlinked design) stays silent below.
      console.warn('[api/designs/:id] portal-visibility audit skipped — design read failed:', designErr.message);
      return;
    }
    if (!designRow?.quote_id) return; // unlinked design — nothing to audit onto
    const { data: quoteRow, error: quoteErr } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', designRow.quote_id)
      .maybeSingle<{ approval_snapshot: unknown }>();
    if (quoteErr || !quoteRow) {
      // Same reasoning: an unconfirmed read is exactly what the helper's
      // guard exists for, but it must be VISIBLE in the logs.
      console.warn(
        '[api/designs/:id] portal-visibility audit skipped — quote snapshot read failed or no row:',
        quoteErr?.message ?? 'no row',
      );
      return;
    }
    const operator = await getOperator();
    await appendQuoteAuditEntry(
      sb,
      designRow.quote_id,
      'portalVisibilityChanges',
      {
        by: operator?.email ?? null,
        at: new Date().toISOString(),
        designId,
        changes,
      },
      '[api/designs/:id]',
      quoteRow.approval_snapshot,
    );
  } catch (err) {
    console.warn('[api/designs/:id] portal-visibility audit append threw:', err);
  }
}
