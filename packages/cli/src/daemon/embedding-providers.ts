/**
 * Embedding-provider implementations used by daemon retrieval paths.
 *
 * Vector persistence and the provider contract stay in vector-store.ts; this
 * module owns network/model-specific embedding behavior.
 */

import type { EmbeddingProvider } from '../vector-store.js';

/** OpenAI-compatible embedding provider. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly cacheKey: string;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(opts: { apiKey: string; model?: string; dimensions?: number; baseURL?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.cacheKey = `openai:${this.baseURL}:${this.model}:${this.dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
    const resp = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: truncated,
        dimensions: this.dimensions,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Embedding API error: ${resp.status} ${resp.statusText}`);
    }
    const json = await resp.json() as { data: Array<{ embedding: number[] }> };
    return json.data[0].embedding;
  }
}

/**
 * Zero-dependency, fully-offline embedder. Hashes word + character-trigram
 * features into a fixed-width L2-normalized vector. This is LEXICAL (token
 * overlap), NOT semantic — a synonym/paraphrase will NOT match. It exists so
 * dRAG always has a ranked ANN path with no model/API (perf + ranking + the
 * pipeline), and as the deterministic CONTRAST BASELINE against which a real
 * semantic model's recall is measured.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hashing-v1';
  readonly dimensions: number;
  readonly cacheKey: string;
  constructor(dimensions = 256) {
    this.dimensions = dimensions;
    this.cacheKey = `hashing:${this.model}:${this.dimensions}`;
  }
  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dimensions).fill(0);
    const lower = text.toLowerCase();
    const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    const bump = (feature: string, weight: number) => {
      vec[djb2(feature) % this.dimensions] += weight;
    };
    for (const w of words) {
      bump('w:' + w, 1);
      for (let i = 0; i + 3 <= w.length; i++) bump('t:' + w.slice(i, i + 3), 0.5); // char trigrams (typo/stem fuzz)
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    return norm === 0 ? vec : vec.map((v) => v / norm);
  }
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Real OFFLINE semantic embedder via a local transformers.js model (default
 * MiniLM, 384-dim) — synonym/paraphrase recall with no API key. The
 * `@huggingface/transformers` package is loaded via a runtime dynamic import
 * (a variable specifier, so it is NOT a build-time dependency); if it is not
 * installed the constructor's first `embed` rejects with an actionable message
 * and the caller falls back to {@link HashingEmbeddingProvider}.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly cacheKey: string;
  private extractor: ((text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>) | null = null;
  private loading: Promise<void> | null = null;

  constructor(opts: { model?: string; dimensions?: number } = {}) {
    this.model = opts.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = opts.dimensions ?? 384;
    this.cacheKey = `local:${this.model}:${this.dimensions}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.extractor) return;
    if (!this.loading) {
      this.loading = (async () => {
        const specifier = '@huggingface/transformers';
        let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
        try {
          mod = (await import(specifier)) as typeof mod;
        } catch {
          throw new Error(
            `local embeddings require the optional dependency "@huggingface/transformers" ` +
              `(run: npm i @huggingface/transformers). Falling back to the hashing embedder.`,
          );
        }
        this.extractor = (await mod.pipeline('feature-extraction', this.model)) as typeof this.extractor;
      })();
    }
    await this.loading;
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded();
    const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
    const out = await this.extractor!(truncated, { pooling: 'mean', normalize: true });
    return Array.from(out.data as ArrayLike<number>);
  }
}
