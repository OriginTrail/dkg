import type { QueryResult } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';

export interface SharedMemoryExpiredOperation {
  readonly uri: string;
  readonly roots: readonly string[];
  readonly scope:
    | { readonly kind: 'legacy' }
    | {
        readonly kind: 'graph-v2';
        readonly kaUal?: string;
        readonly snapshotGraph?: string;
      };
}

interface OperationProjection {
  readonly uri: string;
  readonly roots: Set<string>;
  scopeVersion?: number;
  kaUal?: string;
  snapshotGraph?: string;
}

/** Decode the shared expiry SELECT projection used by discovery and revalidation. */
export function decodeSharedMemoryExpiredOperations(
  result: QueryResult,
): SharedMemoryExpiredOperation[] {
  if (result.type !== 'bindings') return [];
  const operations = new Map<string, OperationProjection>();
  for (const row of result.bindings) {
    if (!row.op) continue;
    let operation = operations.get(row.op);
    if (!operation) {
      operation = { uri: row.op, roots: new Set() };
      operations.set(row.op, operation);
    }
    if (row.re) operation.roots.add(row.re);
    if (row.scopeVersion !== undefined) {
      operation.scopeVersion = Number(stripRdfLiteral(row.scopeVersion));
    }
    operation.kaUal ??= row.kaUal;
    operation.snapshotGraph ??= row.snapshotGraph;
  }
  return [...operations.values()].map(operation => ({
    uri: operation.uri,
    roots: [...operation.roots],
    scope: operation.scopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
      ? {
          kind: 'graph-v2',
          kaUal: operation.kaUal,
          snapshotGraph: operation.snapshotGraph,
        }
      : { kind: 'legacy' },
  }));
}

function stripRdfLiteral(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  const match = /^"(.*)"(?:\^\^.*|@.*)?$/.exec(value);
  return match?.[1] ?? value;
}
