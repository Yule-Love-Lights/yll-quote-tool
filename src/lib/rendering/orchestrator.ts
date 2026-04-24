// End-to-end Phase 1 render pipeline. Callers (POST /api/renders) only need
// to hand over the request — the orchestrator handles hashing, cache lookup,
// budget check, compositing, Gemini call, uploads, and status updates.
//
// Flow:
//   1. hash inputs → cache key
//   2. if cached ready/approved render exists → return it
//   3. check month-to-date spend against RENDER_BUDGET_MONTHLY_USD
//   4. insert 'pending' row
//   5. upload source photo; build composite + mask; upload them
//   6. set status='rendering'; call Gemini
//   7. upload final image; set status='ready'
//   8. on any failure → set status='failed' + error_message, re-throw

import { buildComposite } from './compositor';
import { renderWithGemini, isGeminiConfigured, resolveRenderModel } from './gemini';
import { isInpaintConfigured, runInpaint, InpaintError } from './inpaint';
import {
  cacheKeyFor,
  createRenderRow,
  findByCacheKey,
  getMonthToDateSpendUsd,
  hashBuffer,
  hashJson,
  invalidateMtdCache,
  updateRender,
  uploadArtifact,
} from './storage';
import type { RenderRequest, RenderVisionInput, StoredRender } from './types';

// When a category has zero items (operator unchecked it, or analyzer didn't
// detect any), Gemini STILL loves to hallucinate that category in from its
// training-data prior — the classic "I see a bush, Christmas lights must mean
// net-lights on the bush" bias. Counteract it with an explicit exclusion list
// appended to the prompt as `customPromptSuffix`. Empty categories → no suffix.
function buildNegativeSuffix(vision: RenderVisionInput): string {
  const absent: string[] = [];
  if ((vision.miniLights?.length ?? 0) === 0) {
    absent.push('All bushes, shrubs, hedges, trees, and foliage remain COMPLETELY UNLIT. No mini-lights, no net-lights, no string-wraps, no ornaments, no glow on any vegetation. Render every plant as a dark silhouette against the twilight sky, exactly as it would look on a normal unlit night.');
  }
  if ((vision.wreaths?.length ?? 0) === 0) {
    absent.push('No lit wreaths anywhere — not on the front door, not on the peak, not above the garage, not on the portico.');
  }
  if ((vision.spritzers?.length ?? 0) === 0) {
    absent.push('No spritzer stakes, starburst stakes, pathway lights, or stake-mounted light fixtures in any garden bed, walkway, or lawn area.');
  }
  if ((vision.garland?.length ?? 0) === 0) {
    absent.push('No garland — no lit greenery rope, no draped pine with bulbs, along any railing, porch beam, archway, or door frame.');
  }
  const allLinesEmpty =
    (vision.santasLines?.length ?? 0) === 0 &&
    (vision.gingerbreadLines?.length ?? 0) === 0 &&
    (vision.c9Lines?.length ?? 0) === 0;
  if (allLinesEmpty) {
    absent.push('No roofline or ridge C9 bulbs — no bulbs along gutters, eaves, peaks, or ridges.');
  }
  if (absent.length === 0) return '';
  return [
    'STRICT EXCLUSIONS — the composite and mask intentionally contain ONLY the lighting the customer purchased. The following items are NOT part of this install. Do NOT add them back in even if the scene "feels sparse" without them:',
    ...absent.map((a, i) => `  ${i + 1}. ${a}`),
    'These exclusions OVERRIDE any general "house with Christmas lights" training prior you may have. Render exactly what is in the composite + mask, nothing more.',
  ].join('\n');
}

export class RenderError extends Error {
  constructor(message: string, public code: 'budget' | 'config' | 'compositor' | 'gemini' | 'storage' | 'unknown') {
    super(message);
    this.name = 'RenderError';
  }
}

export async function runRender(req: RenderRequest): Promise<StoredRender> {
  if (!isGeminiConfigured()) {
    throw new RenderError('GEMINI_API_KEY not configured — set it in .env.local', 'config');
  }

  const model = resolveRenderModel(req.model);
  const sourceBuf = Buffer.from(req.photoBase64, 'base64');
  const photoHash = hashBuffer(sourceBuf);
  const visionHash = hashJson(req.vision);
  // Model is part of the cache key so a Flash render doesn't serve back
  // when the caller asks for Pro (or vice-versa).
  const cacheKey = cacheKeyFor(photoHash, visionHash, req.style, model);

  // Cache hit — return prior render for identical inputs. Callers can pass
  // skipCache=true to force a fresh render (admin UI "force rerender" button).
  if (!req.skipCache) {
    const cached = await findByCacheKey(cacheKey);
    if (cached) return cached;
  }

  // Budget guardrail. Fires BEFORE the render row is created so we don't
  // leave half-written rows in the DB when over budget. Guards against
  // NaN from a malformed env var — if someone sets RENDER_BUDGET_MONTHLY_USD=off
  // parseFloat returns NaN and `NaN >= NaN` is false, silently disabling the cap.
  const parsedBudget = parseFloat(process.env.RENDER_BUDGET_MONTHLY_USD ?? '200');
  const budgetLimit = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 200;
  const mtdSpend = await getMonthToDateSpendUsd();
  if (mtdSpend >= budgetLimit) {
    throw new RenderError(
      `Monthly render budget exhausted: $${mtdSpend.toFixed(2)} / $${budgetLimit.toFixed(2)}. Increase RENDER_BUDGET_MONTHLY_USD to continue.`,
      'budget',
    );
  }

  const row = await createRenderRow({
    quoteId: req.quoteId,
    style: req.style,
    model,
    photoHash,
    visionHash,
    cacheKey,
    notes: req.notes,
  });

  try {
    // Upload source first — cheap, lets admin gallery show the input even
    // if later steps fail.
    const sourcePath = await uploadArtifact(row.id, 'source', sourceBuf, req.photoMediaType);

    // Inpaint feature gate. If REPLICATE_API_TOKEN is set and the vision has
    // bush/tree/column detections, we switch to the two-stage pipeline:
    //   stage 1: Gemini renders everything EXCEPT bush mini-lights
    //   stage 2: Replicate inpaint repaints ONLY inside the bush mask regions
    // This sidesteps Gemini's net-light/garland prior entirely.
    const hasBushes = (req.vision.miniLights?.length ?? 0) > 0;
    const useInpaint = isInpaintConfigured() && hasBushes;

    const composite = await buildComposite(
      req.photoBase64,
      req.photoMediaType,
      req.vision,
      { style: req.style, inpaintBushes: useInpaint },
    );

    const compositePath = await uploadArtifact(row.id, 'composite', composite.composite, 'image/png');
    const maskPath = await uploadArtifact(row.id, 'mask', composite.mask, 'image/png');

    await updateRender(row.id, {
      status: 'rendering',
      source_path: sourcePath,
      composite_path: compositePath,
      mask_path: maskPath,
    });

    const negativeSuffix = buildNegativeSuffix(req.vision);

    const gemini = await renderWithGemini({
      sourcePhoto: sourceBuf,
      sourceMediaType: req.photoMediaType,
      composite: composite.composite,
      mask: composite.mask,
      style: req.style,
      model,
      customPromptSuffix: negativeSuffix || undefined,
    });

    const geminiBuf = Buffer.from(gemini.imageBase64, 'base64');
    let finalBuf = geminiBuf;
    let finalMediaType = gemini.mediaType;
    let inpaintLatencyMs = 0;
    let inpaintCostUsd = 0;

    if (useInpaint && composite.bushMask) {
      // Archive the Gemini intermediate so we can debug the before/after.
      // Errors uploading this shouldn't block the final — wrap in try/catch.
      try {
        await uploadArtifact(row.id, 'gemini', geminiBuf, gemini.mediaType);
      } catch (uploadErr) {
        console.warn('[orchestrator] failed to archive gemini intermediate', uploadErr);
      }

      try {
        const inpaint = await runInpaint({
          baseImage: geminiBuf,
          baseMediaType: gemini.mediaType,
          bushMask: composite.bushMask,
          style: req.style,
        });
        finalBuf = Buffer.from(inpaint.imageBase64, 'base64');
        finalMediaType = inpaint.mediaType;
        inpaintLatencyMs = inpaint.latencyMs;
        inpaintCostUsd = inpaint.estimatedCostUsd;
      } catch (err) {
        // Fall back to the Gemini output if inpaint fails — a slightly worse
        // bush render is better than a total render failure. Log loudly so
        // we notice the degradation in monitoring.
        const msg = err instanceof InpaintError ? err.message : err instanceof Error ? err.message : String(err);
        console.error('[orchestrator] inpaint failed, falling back to Gemini output:', msg);
      }
    }

    const finalPath = await uploadArtifact(row.id, 'final', finalBuf, finalMediaType);

    await updateRender(row.id, {
      status: 'ready',
      final_path: finalPath,
      gemini_ms: gemini.latencyMs,
      gemini_cost_usd: gemini.estimatedCostUsd + inpaintCostUsd,
    });
    invalidateMtdCache();

    if (inpaintLatencyMs > 0) {
      console.log(`[orchestrator] render ${row.id} inpaint=${inpaintLatencyMs}ms cost=$${inpaintCostUsd.toFixed(3)}`);
    }

    return {
      ...row,
      status: 'ready',
      source_path: sourcePath,
      composite_path: compositePath,
      mask_path: maskPath,
      final_path: finalPath,
      gemini_ms: gemini.latencyMs,
      gemini_cost_usd: gemini.estimatedCostUsd + inpaintCostUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateRender(row.id, {
      status: 'failed',
      error_message: msg.slice(0, 1000),
    }).catch(() => { /* don't mask the real error */ });
    throw err instanceof RenderError ? err : new RenderError(msg, 'unknown');
  }
}
