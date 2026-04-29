import type { SourceKindHandler } from './source-worker.js';

export interface SourceRegistry<TSource extends { kind: string }, TAsset = unknown> {
  register(kind: string, handler: SourceKindHandler<TSource, TAsset>): void;
  resolve(source: TSource): SourceKindHandler<TSource, TAsset>;
  has(kind: string): boolean;
  listKinds(): string[];
}

export function createSourceRegistry<TSource extends { kind: string }, TAsset = unknown>(
  seed: Record<string, SourceKindHandler<TSource, TAsset>> = {},
): SourceRegistry<TSource, TAsset> {
  const handlers = new Map<string, SourceKindHandler<TSource, TAsset>>(Object.entries(seed));

  return {
    register(kind: string, handler: SourceKindHandler<TSource, TAsset>) {
      handlers.set(kind, handler);
    },
    resolve(source: TSource): SourceKindHandler<TSource, TAsset> {
      const handler = handlers.get(source.kind);
      if (!handler) {
        throw new Error(`Unsupported source kind: ${source.kind}`);
      }
      return handler;
    },
    has(kind: string): boolean {
      return handlers.has(kind);
    },
    listKinds(): string[] {
      return [...handlers.keys()].sort();
    },
  };
}
