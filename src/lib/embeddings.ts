// Image embeddings via Voyage AI (voyage-multimodal-3.5) — #8 Stage B
// similarity retrieval. We embed each captured training example's street photo
// and, at analyze time, the incoming house photo, then rank stored examples by
// cosine similarity in pgvector (closest houses → best few-shot examples).
//
// Raw REST, no SDK dependency: the `voyageai` npm package documents the TEXT
// `embed()` path clearly but its multimodal surface is murky, so we call the
// documented multimodal endpoint directly.
//
// Voyage is OPTIONAL. Every function degrades to `null` when the key is absent
// or anything fails — and `null` is the caller's signal to fall back to
// recency ordering. So a missing or broken Voyage NEVER breaks analyze or
// capture; the system simply behaves like "newest-N" until the key is present
// and examples are embedded, then upgrades itself to similarity retrieval.

const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const VOYAGE_MODEL = 'voyage-multimodal-3.5';

// voyage-multimodal-3.5's default output dimension. MUST match the
// `embedding vector(N)` column + the match RPC's param type in the migration.
export const EMBEDDING_DIMENSIONS = 1024;

export function isEmbeddingConfigured(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

export type EmbeddingInputType = 'query' | 'document';

// Embed one base64 image → a 1024-float vector, or null on ANY failure
// (unconfigured, network, non-2xx, malformed/short response). null ⇒ "use the
// recency fallback". `inputType`: 'document' for stored library examples,
// 'query' for the house currently being analyzed (asymmetric retrieval).
export async function embedImage(
  base64: string,
  mediaType: string,
  inputType: EmbeddingInputType = 'document',
): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;

  // Voyage wants a data URI; accept either raw base64 or a full data: string.
  const dataUri = base64.startsWith('data:') ? base64 : `data:${mediaType};base64,${base64}`;

  try {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input_type: inputType,
        // Pin the dimension so the 1024 contract (column + RPC param) can't be
        // broken by a future change to the model's server-side default.
        output_dimension: EMBEDDING_DIMENSIONS,
        // Content item type MUST be 'image_base64' for a data-URI image
        // (verified against the live API — 'image' is rejected 4xx).
        inputs: [{ content: [{ type: 'image_base64', image_base64: dataUri }] }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[embedImage] Voyage ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    // OpenAI-style envelope: { object, data: [{ embedding: number[] }], ... }.
    // The vector is at data[0].embedding — NOT a top-level `embeddings` field.
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSIONS) {
      console.warn(`[embedImage] unexpected embedding shape (len=${vec?.length ?? 'none'})`);
      return null;
    }
    return vec;
  } catch (err) {
    console.warn('[embedImage] request failed:', err);
    return null;
  }
}
