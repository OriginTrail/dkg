import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { EntitySearchError, validVector, type EntityEmbedder, type EntityEmbeddingConfig } from './types.js';

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
  private async json(path: string, signal: AbortSignal, body?: unknown) {
    const res = await fetch(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok || !res.body) { await res.body?.cancel(); throw new EntitySearchError('ENTITY_EMBEDDING_UNAVAILABLE'); }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new EntitySearchError('ENTITY_EMBEDDING_INVALID');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } finally { await reader.cancel(); }
  }
  async embed(text: string, kind: 'query' | 'document', signal: AbortSignal): Promise<number[]> {
    const tags = await this.json('/api/tags', signal);
    const model = this.config.model.includes(':') ? this.config.model : this.config.model + ':latest';
    if (!tags.models?.some((v: { name: string; digest: string }) => v.name === model && v.digest === this.config.digest)) {
      throw new EntitySearchError('ENTITY_EMBEDDING_MODEL_CHANGED');
    }
    const prefix = kind === 'query' ? this.config.queryPrefix : this.config.documentPrefix;
    const reply = await this.json('/api/embed', signal, { model, input: (prefix ?? '') + text, truncate: false });
    const vector = reply.embeddings?.[0];
    validVector(vector, this.dimensions);
    return vector;
  }
}
