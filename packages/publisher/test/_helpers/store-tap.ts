/**
 * A store wrapper for the listing tests (OT-RFC-73 P8a): it lets a test see every call before it runs, change a result after
 * it ran, and run another store operation at a chosen point of a read, which is how a mutation lands "between pages".
 */
import type { QueryOptions, QueryResult, TripleStore } from '@origintrail-official/dkg-storage';

export interface TappedCall {
  readonly method: string;
  readonly index: number;
  /** The SPARQL text of a `query` / `update`. */
  readonly text?: string;
  readonly options?: QueryOptions;
  readonly source?: string;
}

export interface StoreTap {
  /** Runs before the call reaches the store. */
  before?(call: TappedCall): Promise<void> | void;
  /** Runs after a `query` returned; the value it returns replaces the result. */
  after?(call: TappedCall, result: QueryResult): Promise<QueryResult> | QueryResult;
}

const TAPPED = new Set(['query', 'update', 'insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix',
  'replaceSubject', 'replaceSubjectAndInsert', 'createGraph', 'flush', 'hasGraph', 'dropGraph', 'countQuads']);

export function tapStore(inner: TripleStore, tap: StoreTap = {}): { store: TripleStore; calls: TappedCall[] } {
  const calls: TappedCall[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !TAPPED.has(prop)) return value.bind(target);
      return async (...args: unknown[]) => {
        const isText = prop === 'query' || prop === 'update';
        const options = (isText ? args[1] : undefined) as QueryOptions | undefined;
        const call: TappedCall = { method: prop, index: calls.length, ...(isText ? { text: String(args[0]), options, source: options?.source } : {}) };
        calls.push(call);
        await tap.before?.(call);
        const result = await value.apply(target, args);
        return prop === 'query' && tap.after ? tap.after(call, result as QueryResult) : result;
      };
    },
  }) as TripleStore;
  return { store, calls };
}
