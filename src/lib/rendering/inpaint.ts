// Replicate-backed inpainting pass. Takes the Gemini nighttime render and
// repaints only the bush/tree/column regions with warm-white mini-lights,
// leaving roofline C9s, wreaths, spritzers, and architecture untouched.
//
// Why a second model: Gemini has strong wrong priors for "warm-white dots on
// foliage" — it renders them as net-light mesh or garland swags no matter how
// the prompt is tuned. An SDXL/FLUX inpainter, told to paint "christmas mini-
// lights on foliage" inside a strict mask, doesn't fight us.
//
// Flow:
//   1. Upload geminiImage + bushMask to Replicate as data URLs
//   2. Call the inpainting model with a mini-light prompt
//   3. Poll the prediction until it returns output URLs
//   4. Download the output image and return it as a Buffer
//
// Feature-gated on REPLICATE_API_TOKEN. Orchestrator skips the pass if unset
// so single-token-Gemini renders still work.

const API_BASE = 'https://api.replicate.com/v1';

// Default model: FLUX.1 dev inpainting. Better prior for "christmas lights on
// foliage" than SDXL. Swap via REPLICATE_INPAINT_MODEL env var if needed.
//
// Model format: 'owner/name' uses the latest public version automatically.
// Pin a specific version ('owner/name:hash') once we validate quality.
const DEFAULT_MODEL = 'zsxkib/flux-dev-inpainting';

export class InpaintError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'InpaintError';
  }
}

export function isInpaintConfigured(): boolean {
  return !!process.env.REPLICATE_API_TOKEN;
}

export type InpaintArgs = {
  baseImage: Buffer;         // Gemini output (PNG)
  baseMediaType: string;     // 'image/png' typically
  bushMask: Buffer;          // white-on-black PNG, same dims as baseImage
  style: 'warm-white' | 'multi' | 'red-green';
};

export type InpaintResult = {
  imageBase64: string;
  mediaType: string;
  latencyMs: number;
  estimatedCostUsd: number;
};

// Approximate cost per Replicate FLUX inpaint call. Actual Replicate invoice
// is authoritative — this is only used for budget tracking alongside Gemini.
const INPAINT_COST_USD = 0.035;

export async function runInpaint(args: InpaintArgs): Promise<InpaintResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new InpaintError('REPLICATE_API_TOKEN not configured');

  const modelRef = process.env.REPLICATE_INPAINT_MODEL ?? DEFAULT_MODEL;
  const prompt = buildInpaintPrompt(args.style);
  const negativePrompt =
    'net lights, mesh blanket, rectangular grid of lights, ' +
    'connected garland strings, draped arcs, light swags, ' +
    'solid glow blob, blurry smear, overexposed, daytime, ' +
    'people, text, watermark';

  // Replicate accepts images as data URLs in the input payload. Simpler than
  // uploading to a temp host — we're <10MB per image.
  const baseDataUrl = bufferToDataUrl(args.baseImage, args.baseMediaType);
  const maskDataUrl = bufferToDataUrl(args.bushMask, 'image/png');

  // FLUX-dev-inpainting input schema (verified against Replicate docs
  // 2026-04). Falls through to reasonable defaults for any model that
  // accepts standard `image`/`mask`/`prompt` keys.
  const input: Record<string, unknown> = {
    image: baseDataUrl,
    mask: maskDataUrl,
    prompt,
    negative_prompt: negativePrompt,
    num_inference_steps: 30,
    guidance_scale: 7,
    strength: 0.95, // repaint masked region fully (don't blend in base content)
    output_format: 'png',
  };

  const t0 = Date.now();

  // Kick off prediction.
  const createRes = await fetch(`${API_BASE}/models/${modelRef}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60', // block up to 60s for sync return; else we poll
    },
    body: JSON.stringify({ input }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    throw new InpaintError(
      `Replicate create returned ${createRes.status}: ${errText.slice(0, 500)}`,
      createRes.status,
      errText.slice(0, 2000),
    );
  }

  let prediction = (await createRes.json()) as ReplicatePrediction;

  // If sync-wait didn't complete, poll. Replicate ran for <60s on our test
  // images but larger photos can push past the sync window.
  const maxPollMs = 120_000;
  const pollStart = Date.now();
  while (
    prediction.status !== 'succeeded' &&
    prediction.status !== 'failed' &&
    prediction.status !== 'canceled'
  ) {
    if (Date.now() - pollStart > maxPollMs) {
      throw new InpaintError(`Replicate prediction ${prediction.id} timed out after ${maxPollMs}ms`);
    }
    await sleep(2000);
    const pollRes = await fetch(`${API_BASE}/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pollRes.ok) {
      const errText = await pollRes.text().catch(() => '');
      throw new InpaintError(
        `Replicate poll returned ${pollRes.status}: ${errText.slice(0, 500)}`,
        pollRes.status,
      );
    }
    prediction = (await pollRes.json()) as ReplicatePrediction;
  }

  if (prediction.status !== 'succeeded') {
    throw new InpaintError(
      `Replicate prediction ${prediction.id} ${prediction.status}: ${prediction.error ?? 'no detail'}`,
    );
  }

  // Output is typically an array of URLs; some models return a single URL.
  const outputUrl = Array.isArray(prediction.output)
    ? prediction.output[0]
    : typeof prediction.output === 'string'
      ? prediction.output
      : undefined;
  if (!outputUrl) {
    throw new InpaintError(
      `Replicate prediction ${prediction.id} succeeded but returned no output URL: ${JSON.stringify(prediction.output).slice(0, 300)}`,
    );
  }

  // Download the result.
  const imgRes = await fetch(outputUrl);
  if (!imgRes.ok) {
    throw new InpaintError(`Failed to download Replicate output: ${imgRes.status} ${imgRes.statusText}`);
  }
  const mediaType = imgRes.headers.get('content-type') ?? 'image/png';
  const arrayBuf = await imgRes.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  return {
    imageBase64: buf.toString('base64'),
    mediaType,
    latencyMs: Date.now() - t0,
    estimatedCostUsd: INPAINT_COST_USD,
  };
}

// ---------------------------------------------------------------------------

function buildInpaintPrompt(style: 'warm-white' | 'multi' | 'red-green'): string {
  const palette =
    style === 'multi'
      ? 'multi-colored (red, green, blue, yellow, warm white mix)'
      : style === 'red-green'
        ? 'alternating red and green'
        : 'warm white (incandescent, 2700K)';
  return [
    'professional nighttime photo of a landscaped bush hand-wrapped with ' +
      palette +
      ' christmas mini-lights,',
    'tiny individual pinpoint bulbs (~1/4 inch each) densely scattered on green foliage,',
    'discrete sparkle points on leaves, each bulb a distinct glowing dot with soft halo,',
    'premium residential holiday lighting install, tasteful, realistic restraint,',
    'dark winter evening, blue hour ambient, photoreal, editorial real estate photography,',
    'shallow depth of field, natural foliage visible between bulbs',
  ].join(' ');
}

function bufferToDataUrl(buf: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${buf.toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Replicate prediction response shape. Trimmed to the fields we use.
type ReplicatePrediction = {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | null;
  error?: string | null;
};
