import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import { embedImage, isEmbeddingConfigured, EMBEDDING_DIMENSIONS } from './embeddings';

const KEY = 'pa-test-key';
const VEC = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000);
const okEnvelope = { object: 'list', data: [{ object: 'embedding', embedding: VEC, index: 0 }], model: 'voyage-multimodal-3.5' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.VOYAGE_API_KEY = KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete process.env.VOYAGE_API_KEY;
  vi.unstubAllGlobals();
});

describe('embedImage', () => {
  it('sends the correct multimodal request (type image_base64, pinned dimension) and parses data[0].embedding', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(okEnvelope), { status: 200 }));
    const vec = await embedImage('AAAA', 'image/jpeg', 'document');

    expect(vec).toEqual(VEC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/multimodalembeddings');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('voyage-multimodal-3.5');
    expect(body.input_type).toBe('document');
    expect(body.output_dimension).toBe(EMBEDDING_DIMENSIONS);
    // The content item MUST be type 'image_base64' with a data URI.
    expect(body.inputs[0].content[0]).toEqual({
      type: 'image_base64',
      image_base64: 'data:image/jpeg;base64,AAAA',
    });
  });

  it('uses input_type "query" when asked', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(okEnvelope), { status: 200 }));
    await embedImage('AAAA', 'image/png', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input_type).toBe('query');
  });

  it('passes a full data: URI through unchanged', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(okEnvelope), { status: 200 }));
    await embedImage('data:image/webp;base64,ZZZZ', 'image/webp');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).inputs[0].content[0].image_base64).toBe('data:image/webp;base64,ZZZZ');
  });

  it('returns null on the OLD wrong response shape ({embeddings:[[...]]}) — regression guard', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ embeddings: [VEC] }), { status: 200 }));
    expect(await embedImage('AAAA', 'image/jpeg')).toBeNull();
  });

  it('returns null on a wrong-length vector', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }));
    expect(await embedImage('AAAA', 'image/jpeg')).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 422 }));
    expect(await embedImage('AAAA', 'image/jpeg')).toBeNull();
  });

  it('returns null (and never calls fetch) when unconfigured', async () => {
    delete process.env.VOYAGE_API_KEY;
    expect(isEmbeddingConfigured()).toBe(false);
    expect(await embedImage('AAAA', 'image/jpeg')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await embedImage('AAAA', 'image/jpeg')).toBeNull();
  });

  // W5-021 (#110 wave 5, cost): embedding is a similarity signal, not pixel-
  // perfect detection — downscale the same way analyzePhoto does for vision
  // calls, so a full-resolution photo doesn't inflate every embed request.
  it('downscales a large image before sending to Voyage', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(okEnvelope), { status: 200 }));
    const big = (await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer()).toString('base64');

    await embedImage(big, 'image/jpeg', 'document');

    const sentUri: string = JSON.parse(fetchMock.mock.calls[0][1].body).inputs[0].content[0].image_base64;
    const sentBase64 = sentUri.slice(sentUri.indexOf(',') + 1);
    expect(sentBase64.length).toBeLessThan(big.length);
    const meta = await sharp(Buffer.from(sentBase64, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(1568);
  });
});
