// Gemini 3 Pro Image (aka Nano Banana Pro) client for the render refinement
// pass. Sends the daytime source + sharp composite + mask as three inline
// reference images and asks Gemini to produce the photoreal nighttime
// output. We use the REST API directly — no extra SDK dependency.
//
// Docs: https://ai.google.dev/gemini-api/docs/models#gemini-3-pro-image
// Endpoint: models/gemini-3-pro-image:generateContent (β — may change)
//
// Pricing note: as of 2026-04, image-out is billed per image generated.
// Keep a cost estimate on each call so we can monitor against the monthly
// budget ceiling.

import type { RenderModel, RenderStyle } from './types';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Model IDs + cost estimates (USD per image). Flash is ~5× cheaper and has
// a free daily tier at lower visual fidelity; Pro is photoreal. Actual
// Google invoice is authoritative — these are only used to track against
// RENDER_BUDGET_MONTHLY_USD.
const MODELS: Record<RenderModel, { id: string; costUsd: number; label: string }> = {
  pro:    { id: 'gemini-3-pro-image-preview',     costUsd: 0.134, label: 'Gemini 3 Pro Image (Nano Banana Pro)' },
  flash2: { id: 'gemini-3.1-flash-image-preview', costUsd: 0.067, label: 'Gemini 3.1 Flash Image (Nano Banana 2)' },
  flash:  { id: 'gemini-2.5-flash-image',         costUsd: 0.04,  label: 'Gemini 2.5 Flash Image (Nano Banana)' },
};

export function resolveRenderModel(requested?: RenderModel): RenderModel {
  if (requested === 'flash' || requested === 'flash2' || requested === 'pro') return requested;
  const envDefault = (process.env.RENDER_MODEL ?? '').toLowerCase();
  if (envDefault === 'flash' || envDefault === 'flash2' || envDefault === 'pro') return envDefault;
  return 'pro';
}

// Per-package portal variants run on a separate (typically cheaper) model
// than the main render. The full-package hero stays on RENDER_MODEL (Pro
// by default) — only the smaller per-package card images use this. A
// missing/invalid env var falls back to flash2 (Gemini 3.1 Flash, Nano
// Banana 2) — the sweet spot of "good enough for card-sized images at
// 50% the cost of Pro."
export function resolveVariantModel(): RenderModel {
  const envVal = (process.env.RENDER_VARIANT_MODEL ?? '').toLowerCase();
  if (envVal === 'flash' || envVal === 'flash2' || envVal === 'pro') return envVal;
  return 'flash2';
}

export function modelIdFor(model: RenderModel): string { return MODELS[model].id; }
export function modelCostFor(model: RenderModel): number { return MODELS[model].costUsd; }

export type GeminiRenderArgs = {
  sourcePhoto: Buffer;        // daytime source
  sourceMediaType: string;    // 'image/jpeg' | 'image/png'
  composite: Buffer;          // sharp composite (bulbs placed, dusk-toned)
  mask: Buffer;               // white-on-black mask
  style: RenderStyle;
  model: RenderModel;
  customPromptSuffix?: string;
};

export type GeminiRenderResult = {
  imageBase64: string;
  mediaType: string;
  latencyMs: number;
  estimatedCostUsd: number;
};

export class GeminiError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// Gemini 3 Pro Image preview intermittently routes image requests through
// an internal tool (`google:image_gen`), generates a MALFORMED tool call, and
// returns finishReason=MALFORMED_FUNCTION_CALL with empty content. It's
// probabilistic — a second call with the same payload almost always works.
// We detect this case plus the broader "no image part" symptom and retry
// with small temperature jitter to break any deterministic failure mode.
const MAX_RENDER_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [0, 1_500, 4_000]; // 0 = first try, then 1.5s, then 4s

function isRetriableEmptyImage(json: GeminiResponse): boolean {
  const cand = json.candidates?.[0];
  if (!cand) return true; // no candidates at all → retry
  const finish = cand.finishReason ?? '';
  if (finish === 'MALFORMED_FUNCTION_CALL') return true;
  // finishReason=STOP with no inline data means the model text-responded
  // instead of returning an image — also worth one retry.
  const parts = cand.content?.parts ?? [];
  const hasImg = parts.some(p => (p.inlineData?.data ?? p.inline_data?.data));
  return !hasImg;
}

export async function renderWithGemini(args: GeminiRenderArgs): Promise<GeminiRenderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('GEMINI_API_KEY not configured');

  // 2.5 Flash is weaker at following multi-image instructions — it needs a
  // short keyword-front-loaded prompt and fewer references (source + mask
  // only; the composite biases it toward daytime-tone passthrough).
  // 3.1 Flash (flash2) and 3 Pro both handle the full 3-reference prompt.
  const isLegacyFlash = args.model === 'flash';
  const prompt = isLegacyFlash
    ? buildFlashPrompt(args.style, args.customPromptSuffix)
    : buildProPrompt(args.style, args.customPromptSuffix);

  const requestParts: Array<Record<string, unknown>> = [
    { text: prompt },
    { inline_data: { mime_type: args.sourceMediaType, data: args.sourcePhoto.toString('base64') } },
  ];
  if (!isLegacyFlash) {
    requestParts.push({ inline_data: { mime_type: 'image/png', data: args.composite.toString('base64') } });
  }
  requestParts.push({ inline_data: { mime_type: 'image/png', data: args.mask.toString('base64') } });

  const modelId = MODELS[args.model].id;
  const t0 = Date.now();

  let lastJson: GeminiResponse | null = null;
  let lastFinishReason = '';

  for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      console.warn(
        `[gemini] retry ${attempt}/${MAX_RENDER_ATTEMPTS - 1} — prior finishReason=${lastFinishReason || 'EMPTY'}`,
      );
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 4_000));
    }

    // Nudge temperature up slightly on retry so we don't re-enter the exact
    // same deterministic failure state. Keeps first attempt at 0.2 for
    // faithful refinement; retries drift to 0.35 / 0.5.
    const temperature = 0.2 + attempt * 0.15;

    const body = {
      contents: [{ role: 'user', parts: requestParts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        temperature,
      },
    };

    const res = await fetch(`${API_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // 429 / 5xx are worth a retry; anything else is fatal.
      const errText = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RENDER_ATTEMPTS - 1) {
        lastFinishReason = `HTTP_${res.status}`;
        continue;
      }
      throw new GeminiError(
        `Gemini API returned ${res.status}: ${errText.slice(0, 500)}`,
        res.status,
        errText.slice(0, 2000),
      );
    }

    const json = await res.json() as GeminiResponse;
    lastJson = json;
    lastFinishReason = json.candidates?.[0]?.finishReason ?? '';

    const responseParts = json.candidates?.[0]?.content?.parts ?? [];
    // Google's REST API returns camelCase in responses but accepts snake_case in
    // requests. Accept either shape defensively so future API changes don't break us.
    const imgPart = responseParts.find(p => (p.inlineData?.data ?? p.inline_data?.data));
    const inline = imgPart?.inlineData ?? imgPart?.inline_data;
    if (inline?.data) {
      const latencyMs = Date.now() - t0;
      if (attempt > 0) {
        console.log(`[gemini] succeeded on retry ${attempt} (${latencyMs}ms total)`);
      }
      return {
        imageBase64: inline.data,
        mediaType: inline.mimeType ?? inline.mime_type ?? 'image/png',
        latencyMs,
        estimatedCostUsd: MODELS[args.model].costUsd * (attempt + 1),
      };
    }

    // No image this attempt. Retry if symptom matches the known flaky modes.
    if (!isRetriableEmptyImage(json)) break;
  }

  // All retries exhausted. Build a diagnostic error so we can tell from the
  // admin gallery whether it was MALFORMED_FUNCTION_CALL (Gemini bug) vs.
  // a genuine content rejection (finishReason=SAFETY / RECITATION etc.).
  const diag = lastJson ? JSON.stringify(lastJson).slice(0, 600) : 'no response body captured';
  throw new GeminiError(
    `Gemini returned no image after ${MAX_RENDER_ATTEMPTS} attempts. Last finishReason=${lastFinishReason || 'EMPTY'}. Response: ${diag}`,
  );
}

// --- Prompt builder ---------------------------------------------------------
// The prompt is the product. It tells Gemini what to treat as ground truth
// (architecture from image 1), what to match (light positions from image 3),
// and what aesthetic to produce (Yule Love Lights warm-white C9 look).
//
// Reference photos sent 2026-04-22 establish the visual target:
// warm-white C9 everywhere, red bow on wreaths, dense bush/tree wraps,
// preserved interior window glow, dark-but-not-black sky with subtle gradient.

function buildProPrompt(style: RenderStyle, suffix?: string): string {
  const palette = paletteDescription(style);
  return [
    `You are a professional architectural photography retoucher producing a photoreal nighttime holiday-lighting visualization for Yule Love Lights, a Long Island luxury Christmas lighting company.`,
    ``,
    `You are given three reference images:`,
    `  1. DAYTIME SOURCE PHOTO — the actual house, in daylight. This is the absolute ground truth for architecture, roofline, window positions, landscaping, and parked vehicles. Do NOT alter the building. Preserve roof geometry, siding, shutters, trim, porch columns, foundation plantings, mature trees, driveways, any vehicles, and any mid-roof surface features exactly as they appear.`,
    `  2. LIGHTING PREVIEW COMPOSITE — this is NOT a hint, it is THE ANSWER for light placement. Every light in the final render already exists on this image at its final position, size, count, and spacing. Roofline C9s are pre-stamped as glowing dots along the gutters. Bush/tree mini-lights are pre-stamped as smaller glowing dots on the foliage. Wreaths and spritzer stakes are pre-stamped as literal transparent sprites. YOUR JOB IS TO PHOTOGRAPH THIS COMPOSITE AS IF IT WERE A REAL HOUSE AT NIGHT — not to reinterpret it. Preserve every light's position, count, and relative size EXACTLY as shown. Do not add lights. Do not remove lights. Do not redistribute or reshape them. Do not invent strings, wires, garland, swags, arcs, drapes, or net-light mesh between bulbs. If the composite shows 37 dots on a bush, the final render has 37 warm pinpoints in those exact positions.`,
    `  3. PLACEMENT MASK — pure black with WHITE strokes and dots. Secondary reference confirming the exact pixel positions from image 2. Use this only to verify you haven't drifted off the composite's positions.`,
    ``,
    `LIGHT STYLING (apply to the pre-placed lights — do not change their positions):`,
    `  - Roofline bulbs (the dots along gutters/ridges in image 2) are standard residential C9 bulbs — ~1 inch tall teardrop glass. SIZE IS CRITICAL, YOU HAVE BEEN RENDERING THESE TOO LARGE. Concrete size references:`,
    `      • Bulb diameter should be roughly the SAME WIDTH as the gutter trough itself (maybe slightly narrower), NOT wider than the gutter.`,
    `      • A bulb is significantly SMALLER than a wreath's red bow visible in the composite.`,
    `      • A bulb is about 1/40th the height of a standard window — so if a first-floor window is ~100px tall in the rendered image, each bulb is ~2-3px tall.`,
    `      • A bulb is smaller than the diameter of a typical door knob.`,
    `      • Think "christmas lights at a tasteful luxury home," NOT "commercial storefront," NOT "carnival," NOT "giant decorative ornament."`,
    `    Render each bulb as a small, clean, individual warm-white point of light along the gutter edge — clearly visible but subtle. If in doubt, SMALLER IS CORRECT. Features: gentle halo, incandescent-warm filament glow, screwed into a dark base clip on the gutter edge, soft bloom on the adjacent shingle. Not flat dots, not LEDs, not floating orbs, NOT oversized.`,
    `  - Bush/tree bulbs (small dots inside foliage regions in image 2) are mini-lights: each rendered as ONE tiny (~1/4" diameter, pencil-eraser size) warm-white bulb at its exact pre-placed position, with a faint halo. Each bulb is independent — NO wires, strings, garlands, arcs, swags, drapes, or mesh connecting them. Foliage silhouette remains visible between bulbs. Imagine it as scattered fireflies landed on the bush, each a discrete pinpoint.`,
    `  - Wreath sprites → render each as a real lit wreath at the sprite's exact center, diameter, and orientation: green noble pine rim with dense warm-white mini-lights around the circumference, prominent red velvet bow with gold trim at top (ornamented variant adds mixed red/green/silver balls). Do not add bulbs outside the wreath rim.`,
    `  - Spritzer sprites → render each as a real installed ~2ft-tall metallic starburst stake at the sprite's exact position: thin wires radiating from a central stem, warm-white LED pinpoints at every wire tip, planted in garden soil.`,
    ``,
    `COUNT INTEGRITY: the number of each light type in the final render MUST match image 2 EXACTLY. Do not add extras, do NOT drop any. This is especially important for sprite-based items (wreaths, spritzer stakes): each one in the composite is a purchased, installed piece of product — if you render 3 spritzers when the composite shows 4, the customer gets an incorrect preview. Before finalizing the image, literally COUNT every wreath sprite and every spritzer stake in the composite, then count yours, and confirm the numbers match. Roofline bulbs = count in composite. Bush mini-lights = count in composite. Wreaths = count in composite. Spritzer stakes = count in composite.`,
    ``,
    `ROOFLINE CONTINUITY — READ THIS TWICE: roofline runs in the composite are continuous, evenly-spaced bulbs from one end of a gutter/rake/ridge to the other with NO gaps. Every single glowing dot on a roofline in image 2 is a BILLABLE INSTALLED C9 BULB. You are not a stylist. You are not "cleaning up spacing" or "making it look more elegant." Each composite dot = one rendered bulb, 1:1, in the exact same position. Missing even ONE bulb mid-run is a defect the customer will notice and is the single most common failure mode of this prompt.`,
    ``,
    `BEFORE FINALIZING, do a roofline walk-through:`,
    `  - For each roofline run in the composite (front gutter, side gutter, each rake, each ridge), scan left-to-right and count the bulbs.`,
    `  - Scan your rendered roofline the same way and count.`,
    `  - If counts don't match or the spacing looks uneven where the composite was even, you dropped a bulb — regenerate until every composite dot has a matching bulb. Uniform spacing is the tell: if three bulbs look close together and then there's a gap bigger than the others, you've skipped one. FIX IT.`,
    `  - Do NOT skip bulbs because:`,
    `      • the shingle behind that bulb is dark`,
    `      • a tree branch, wire, or silhouette partially crosses in front of the bulb`,
    `      • the bulb sits near the edge of a dormer, vent, or skylight`,
    `      • the run "looks fine" with one fewer bulb (it does not — it looks wrong)`,
    `None of those are valid excuses. Every bulb in the composite gets rendered.`,
    ``,
    `Produce a single photoreal nighttime photograph of the same house, same camera angle, with the holiday lights installed. Requirements:`,
    ``,
    `TIME OF DAY & SKY`,
    `  - Early evening / blue hour. Dark but not pitch-black sky with a subtle tonal gradient from deep navy overhead to slightly warmer tone near the horizon.`,
    `  - No prominent stars. No illustrated or fake sky.`,
    `  - Soft ambient darkness over the landscaping; grass and shrubs should be visible as dim silhouettes, not pure black.`,
    ``,
    `LIGHT APPEARANCE — ${palette.label}`,
    `  - ${palette.description}`,
    `  - Individual bulbs should look like real installed C9 bulbs — warm, luminous, with gentle bloom and soft shadows cast on adjacent surfaces.`,
    `  - Each bulb contributes subtle realistic glow to the surface it is mounted on (shingles near gutter bulbs, branches near bush-wrap bulbs).`,
    `  - No neon. No LED-strip look. No flat clipart bulbs.`,
    ``,
    `INTERIOR GLOW`,
    `  - Every window visible in the source should emit a warm yellow interior light, like the family is home. This is a signature cinematic element — do NOT darken the windows.`,
    ``,
    `ARCHITECTURE INTEGRITY`,
    `  - Do not redesign the house. Do not add gables, columns, chimneys, or trim.`,
    `  - Do not alter landscaping beyond natural darkening. Do not remove or relocate trees, bushes, cars, or people.`,
    `  - Preserve every mid-roof surface feature (skylights, vents, dormers, dark shingle panels, textured areas) exactly as it appears in the source photo — but do NOT let those features suppress the holiday lights shown in the composite. Every bulb marked in image 2 must appear in the final render at NORMAL size and brightness. Lights installed on a gutter edge or ridge edge are always in front of whatever is on the roof slope behind them. Normal-size bulbs, rendered everywhere the composite shows them — that is the rule.`,
    `  - NEVER paint Christmas lights on power lines, telephone wires, utility cables, service drops, tree branches, or ANY object that is not the physical roof edge of the subject house. Wires often run in front of or above rooflines — they are NOT part of the house and we do not install lights on them. If the composite does not show a bulb on a wire, the final render must not show one either. Do not "fill in" an apparent gap along a wire to make a run look continuous. Wires stay unlit; only the gutters, rakes, and ridges get bulbs.`,
    ``,
    `FRAMING`,
    `  - Same camera angle, focal length, and crop as the source photo.`,
    `  - Photograph aesthetic: 24mm full-frame, f/5.6, tripod, long exposure. Clean, high-end real estate / editorial quality.`,
    ``,
    `OUTPUT`,
    `  - Return a single photoreal image. No captions, no overlays, no borders, no watermarks.`,
    suffix ? `\nADDITIONAL CONSTRAINTS:\n${suffix}` : '',
  ].join('\n');
}

// Flash prompt: short, imperative, keyword-heavy. Flash tends to passthrough
// the daytime source when given a nuanced prompt, so we front-load the
// transformation keywords ("NIGHTTIME", "DARK SKY") and keep only two
// references (source + mask). No composite — it biases Flash toward the
// daytime tone.
function buildFlashPrompt(style: RenderStyle, suffix?: string): string {
  const palette = paletteDescription(style);
  return [
    `TRANSFORM this daytime house photo into a PHOTOREAL NIGHTTIME photograph with Christmas lights installed.`,
    ``,
    `NIGHTTIME. DARK SKY. BLUE HOUR. Interior windows GLOW warm yellow.`,
    ``,
    `LIGHTS: ${palette.label}. ${palette.description}`,
    ``,
    `Image 1 = the house (keep architecture, roofline, windows, landscaping, cars IDENTICAL).`,
    `Image 2 = placement mask. WHITE pixels = where lights must appear. BLACK pixels = no lights.`,
    ``,
    `INTERPRET THE MASK BY SHAPE:`,
    `  - LONG WHITE STROKES along rooflines → continuous runs of C9 bulbs spaced ~12" apart along that gutter/ridge.`,
    `  - SMALL white dots (visibly smaller than roofline stroke dots) inside a bush/tree/column region → mini-lights, NOT C9s. Render each as a tiny pinpoint (~1/4") warm-white bulb at that exact position. Size cue: if the mask dot is small, the rendered bulb is small. Do NOT connect dots with wire, garland, arcs, or drapes. Do NOT render a net-light blanket. Discrete pinpoints on foliage — the plant silhouette must remain visible between them.`,
    `  - Isolated small dots away from any larger structure → a single accent light (e.g., a stake head or single bulb). Render as ONE warm-white glow point, not a cluster.`,
    `(Note: the legacy Flash tier does not receive the composite image, so wreaths and spritzers from sprite overlays will not render — use Pro or Flash 3.1 for those.)`,
    ``,
    `Bulbs look like real incandescent — round, warm, soft bloom, casting glow on adjacent surfaces. Mini-lights are smaller and denser than C9s.`,
    `Same camera angle as source. No text, no captions, no borders.`,
    suffix ? `\n${suffix}` : '',
  ].join('\n');
}

function paletteDescription(style: RenderStyle): { label: string; description: string } {
  if (style === 'multi') {
    return {
      label: 'MULTI-COLOR C9',
      description: 'Traditional multi-color C9 bulbs: saturated red, green, blue, and amber evenly distributed along each run. No white. Bulbs are large (~1 inch), rounded, incandescent-warm with visible filaments. Color balance is cheerful and classic, not rainbow-chaotic.',
    };
  }
  if (style === 'red-green') {
    return {
      label: 'RED & GREEN C9',
      description: 'Alternating red and green C9 bulbs along every run. No other colors. Saturated, classic holiday palette, incandescent-warm glow.',
    };
  }
  return {
    label: 'WARM-WHITE C9',
    description: 'Warm white C9 bulbs at approximately 2700K — soft tungsten glow, champagne highlights, slight amber cast. This is the signature Yule Love Lights look: premium, elegant, uniform. No cool-white, no multi-color.',
  };
}

// --- Response types ---------------------------------------------------------
type GeminiInlineData = {
  mimeType?: string;   // camelCase — what Google actually returns
  mime_type?: string;  // snake_case — tolerated for robustness
  data?: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GeminiInlineData;
        inline_data?: GeminiInlineData;
      }>;
    };
    // Pro-preview occasionally fails the image generation and fills these
    // fields instead of `content.parts[].inlineData`. We detect these to
    // drive the retry loop (see renderWithGemini).
    finishReason?: string;
    finishMessage?: string;
  }>;
};
