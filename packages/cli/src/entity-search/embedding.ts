import { readResponseBodyBytesBounded, BoundedResponseBodyLimitError } from '@origintrail-official/dkg-http-utils';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { EntitySearchError, validVector, type EntityEmbedder, type EntityEmbeddingConfig } from './types.js';

interface ModelEntry { name: string; digest: string }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function models(value: unknown): ModelEntry[] {
  const entries = record(value)?.models;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new EntitySearchError('ENTITY_EMBEDDING_INVALID');
  return entries.map(entry => {
    const model = record(entry);
    if (typeof model?.name !== 'string' || typeof model.digest !== 'string') {
      throw new EntitySearchError('ENTITY_EMBEDDING_INVALID');
    }
    return { name: model.name, digest: model.digest };
  });
}
function embedding(value: unknown, dimensions: number): number[] {
  const vectors = record(value)?.embeddings;
  const vector = Array.isArray(vectors) ? vectors[0] : undefined;
  validVector(vector, dimensions);
  return vector;
}

/** Explicitly configured local inference only. No fallback to a billed provider. */
export class LocalEntityEmbedder implements EntityEmbedder {
  readonly fingerprint: string;
  readonly dimensions: number;
  private base: string;
  constructor(private config: EntityEmbeddingConfig) {
    const url = new URL(config.baseURL ?? 'http://127.0.0.1:11434');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (config.provider !== 'ollama' || !isIP(host) || !(host === '::1' || host.startsWith('127.'))
      || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[a-f0-9]{64}$/.test(config.digest) || !config.model || config.model.length > 256
      || !Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 4096
      || (config.queryPrefix?.length ?? 0) > 256 || (config.documentPrefix?.length ?? 0) > 256) {
      throw new EntitySearchError('ENTITY_EMBEDDING_CONFIG_INVALID', 400);
    }
    this.base = url.origin;
    this.dimensions = config.dimensions;
    this.fingerprint = createHash('sha256').update(JSON.stringify([config.provider, config.model, config.digest, config.dimensions,
      config.queryPrefix ?? "", config.documentPrefix ?? ""])).digest('hex');
  }
  private async json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const res = await fetch(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok || !res.body) { await res.body?.cancel(); throw new EntitySearchError('ENTITY_EMBEDDING_UNAVAILABLE'); }
    try {
      const bytes = await readResponseBodyBytesBounded(res, 1024 * 1024);
      return JSON.parse(Buffer.from(bytes).toString());
    } catch (error) {
      if (error instanceof BoundedResponseBodyLimitError) throw new EntitySearchError('ENTITY_EMBEDDING_INVALID');
      throw error;
    }
  }
  private async model(signal: AbortSignal): Promise<string> {
    const tags = models(await this.json('/api/tags', signal));
    const model = this.config.model.includes(':') ? this.config.model : this.config.model + ':latest';
    if (!tags.some(v => v.name === model && v.digest === this.config.digest)) {
      throw new EntitySearchError('ENTITY_EMBEDDING_MODEL_CHANGED');
    }
    return model;
  }
  async ready(signal: AbortSignal): Promise<boolean> {
    await this.model(signal);
    const running = models(await this.json('/api/ps', signal));
    return running.some(v => v.digest === this.config.digest) === true;
  }
  async embed(text: string, kind: 'query' | 'document', signal: AbortSignal): Promise<number[]> {
    await this.model(signal);
    const prefix = kind === 'query' ? this.config.queryPrefix : this.config.documentPrefix;
    // Tag checks alone cannot detect A -> B -> A during inference. Require an
    // immutable local manifest reference; unsupported providers fail closed.
    const model = `sha256:${this.config.digest}`;
    const reply = await this.json('/api/embed', signal, { model, input: (prefix ?? '') + text, truncate: false, keep_alive: '5m' });
    await this.model(signal);
    return embedding(reply, this.dimensions);
  }
}
