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
import type { RenderRequest, StoredRender } from './types';

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

  // Cache hit — return prior render for identical inputs.
  const cached = await findByCacheKey(cacheKey);
  if (cached) return cached;

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

    const composite = await buildComposite(
      req.photoBase64,
      req.photoMediaType,
      req.vision,
      { style: req.style },
    );

    const compositePath = await uploadArtifact(row.id, 'composite', composite.composite, 'image/png');
    const maskPath = await uploadArtifact(row.id, 'mask', composite.mask, 'image/png');

    await updateRender(row.id, {
      status: 'rendering',
      source_path: sourcePath,
      composite_path: compositePath,
      mask_path: maskPath,
    });

    const gemini = await renderWithGemini({
      sourcePhoto: sourceBuf,
      sourceMediaType: req.photoMediaType,
      composite: composite.composite,
      mask: composite.mask,
      style: req.style,
      model,
    });

    const finalBuf = Buffer.from(gemini.imageBase64, 'base64');
    const finalPath = await uploadArtifact(row.id, 'final', finalBuf, gemini.mediaType);

    await updateRender(row.id, {
      status: 'ready',
      final_path: finalPath,
      gemini_ms: gemini.latencyMs,
      gemini_cost_usd: gemini.estimatedCostUsd,
    });
    invalidateMtdCache();

    return {
      ...row,
      status: 'ready',
      source_path: sourcePath,
      composite_path: compositePath,
      mask_path: maskPath,
      final_path: finalPath,
      gemini_ms: gemini.latencyMs,
      gemini_cost_usd: gemini.estimatedCostUsd,
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
