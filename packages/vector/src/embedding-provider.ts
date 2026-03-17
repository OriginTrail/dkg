export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbeddingResult[]>;
  dimensions(): number;
  modelName(): string;
}

export interface EmbeddingProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  dimensions?: number;
  batchSize?: number;
}

export class TransientEmbeddingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TransientEmbeddingError';
    this.status = status;
  }
}

export class PermanentEmbeddingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PermanentEmbeddingError';
    this.status = status;
  }
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DIMENSIONS = 512;
const DEFAULT_BATCH_SIZE = 100;

interface EmbeddingApiResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly config: Required<EmbeddingProviderConfig>;

  constructor(config: EmbeddingProviderConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: trimTrailingSlash(config.baseURL ?? DEFAULT_BASE_URL),
      dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    };
  }

  dimensions(): number {
    return this.config.dimensions;
  }

  modelName(): string {
    return this.config.model;
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    const batches = chunk(texts, this.config.batchSize);
    const results = await Promise.all(batches.map((batch) => this.embedBatch(batch)));
    return results.flat();
  }

  private async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
          dimensions: this.config.dimensions,
        }),
      });
    } catch (error) {
      throw new TransientEmbeddingError(
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const message = normalizeError(response.status, raw);
      if (isTransientStatus(response.status)) {
        throw new TransientEmbeddingError(message, response.status);
      }
      throw new PermanentEmbeddingError(message, response.status);
    }

    const body = await response.json() as EmbeddingApiResponse;
    const items = body.data ?? [];
    if (items.length !== texts.length) {
      throw new TransientEmbeddingError(
        `Embedding API returned ${items.length} vectors for ${texts.length} inputs`,
      );
    }

    const tokensPerItem = Math.ceil((body.usage?.total_tokens ?? 0) / Math.max(items.length, 1));
    return items.map((item, index) => {
      const embedding = item.embedding ?? [];
      if (embedding.length !== this.config.dimensions) {
        throw new TransientEmbeddingError(
          `Embedding dimension mismatch for item ${index}: expected ${this.config.dimensions}, got ${embedding.length}`,
        );
      }
      return {
        embedding,
        tokenCount: tokensPerItem,
      };
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function normalizeError(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as EmbeddingApiResponse;
    const message = parsed.error?.message;
    if (message) return message;
  } catch {
    // Ignore malformed JSON and fall through to the raw body.
  }

  return raw.trim() || `Embedding API request failed with status ${status}`;
}
