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

  const body = {
    contents: [{ role: 'user', parts: requestParts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      temperature: 0.2,  // low — we want faithful refinement, not creative drift
    },
  };

  const modelId = MODELS[args.model].id;
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new GeminiError(
      `Gemini API returned ${res.status}: ${errText.slice(0, 500)}`,
      res.status,
      errText.slice(0, 2000),
    );
  }

  const json = await res.json() as GeminiResponse;
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  // Google's REST API returns camelCase in responses but accepts snake_case in
  // requests. Accept either shape defensively so future API changes don't break us.
  const imgPart = responseParts.find(p => (p.inlineData?.data ?? p.inline_data?.data));
  const inline = imgPart?.inlineData ?? imgPart?.inline_data;
  if (!inline?.data) {
    throw new GeminiError(
      `Gemini returned no image part. Response: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }

  return {
    imageBase64: inline.data,
    mediaType: inline.mimeType ?? inline.mime_type ?? 'image/png',
    latencyMs,
    estimatedCostUsd: MODELS[args.model].costUsd,
  };
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
    `  1. DAYTIME SOURCE PHOTO — the actual house, in daylight. This is the absolute ground truth for architecture, roofline, window positions, landscaping, and parked vehicles. Do NOT alter the building. Preserve roof geometry, siding, solar panels, shutters, trim, porch columns, foundation plantings, mature trees, driveways, and any vehicles exactly as they appear.`,
    `  2. LIGHTING PREVIEW COMPOSITE — a crude dusk-toned preview with bulb dots placed where lights should be. Use this only as a placement and brightness reference.`,
    `  3. PLACEMENT MASK — pure black with WHITE strokes and dots. Lights in the final image MUST appear exactly where the white pixels are, with no lights anywhere the mask is black.`,
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
    `  - If solar panels are visible, keep them exactly in place.`,
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
    `Image 2 = placement mask. Place glowing C9 bulbs ONLY where the mask is WHITE. No lights where mask is black.`,
    ``,
    `Bulbs look like real incandescent C9 — round, warm, soft bloom, casting glow on adjacent surfaces.`,
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
  }>;
};
