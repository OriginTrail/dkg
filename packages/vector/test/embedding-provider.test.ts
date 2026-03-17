import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIEmbeddingProvider,
  PermanentEmbeddingError,
  TransientEmbeddingError,
} from '../src/embedding-provider.js';

describe('OpenAIEmbeddingProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('batches requests and returns embeddings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { embedding: [1, 0, 0] },
          { embedding: [0, 1, 0] },
        ],
        usage: { total_tokens: 8 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { embedding: [0, 0, 1] },
        ],
        usage: { total_tokens: 4 },
      }), { status: 200 }));

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'test-key',
      dimensions: 3,
      batchSize: 2,
    });

    const embeddings = await provider.embed(['alpha', 'beta', 'gamma']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(embeddings).toHaveLength(3);
    expect(embeddings[0].embedding).toEqual([1, 0, 0]);
    expect(embeddings[2].embedding).toEqual([0, 0, 1]);
  });

  it('classifies 429 and 5xx responses as transient errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 3 });

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(TransientEmbeddingError);
  });

  it('classifies 4xx authorization and validation responses as permanent errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 3 });

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(PermanentEmbeddingError);
  });

  it('treats network failures as transient errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'test-key', dimensions: 3 });

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(TransientEmbeddingError);
  });
});
