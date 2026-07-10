import { describe, it, expect } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { readSwmDataPage } from '../src/sync/responder/graph-plan.js';
import { createResponderSyncRowListMemo } from '../src/sync/responder/snapshot-cache.js';

/**
 * Regression for the `/dkg/x/sync` responder crash:
 * `[ProtocolRouter] handler error on /dkg/x/sync from <peer>: Maximum call
 * stack size exceeded`.
 *
 * The TTL-cutoff shared-memory data path (`readFreshSwmDataRows`) materialises
 * every fresh row of a data graph into one array. When a single shared-memory
 * graph holds more rows than V8's argument-spread limit (~1.25e5), the former
 * `rows.push(...graphRows.filter(...))` threw `RangeError: Maximum call stack
 * size exceeded`, the stream was aborted, and a large member never received the
 * data (it retried and backed off forever).
 *
 * This drives the real `readSwmDataPage` snapshot (cached) path with a store
 * that returns a single fresh shared-memory graph far larger than that limit
 * and asserts the responder returns the full row set instead of crashing.
 */
describe('sync responder tolerates a shared-memory graph larger than the spread limit', () => {
  it('serves a >limit fresh SWM-data graph without a stack overflow', async () => {
    const cg = 'test/overflow-cg';
    const dataGraph = `did:dkg:context-graph:${cg}/_shared_memory`;
    const metaGraph = `${dataGraph}_meta`;
    const root = 'urn:root:overflow';
    // Safely above V8's ~1.25e5 argument-spread limit — the old
    // `rows.push(...)` overflowed the stack here; the fix must not.
    const rowCount = 200_000;

    const bigRows = Array.from({ length: rowCount }, (_, i) => ({
      g: dataGraph,
      s: root,
      p: 'http://schema.org/name',
      o: `"v${i}"`,
    }));

    const store = {
      async query(sparql: string) {
        // fresh SWM roots (readFreshSwmRoots)
        if (sparql.includes('WorkspaceOperation')) {
          return { type: 'bindings' as const, bindings: [{ root }] };
        }
        // rows across graphs (readRowsAcrossGraphs)
        if (sparql.includes('GRAPH ?g') && sparql.includes('?s ?p ?o')) {
          return { type: 'bindings' as const, bindings: bigRows };
        }
        return { type: 'bindings' as const, bindings: [] };
      },
    } as unknown as TripleStore;

    // No budget → the snapshot is cached unconditionally, so the request
    // exercises the in-memory snapshot (spread) path, not the paged fallback.
    const memo = createResponderSyncRowListMemo(120_000, 32, { phase: 'durable_data' });

    const rows = await readSwmDataPage({
      store,
      graphList: [dataGraph, metaGraph],
      registeredSubGraphNames: [],
      contextGraphId: cg,
      cutoffIso: '2020-01-01T00:00:00.000Z',
      offset: 0,
      limit: rowCount + 10,
      rowListMemo: memo,
      rowListCacheKey: `${cg}:swm-data`,
      refreshRowList: true,
    });

    expect(rows).toHaveLength(rowCount);
    expect(rows.every((r) => r.s === root)).toBe(true);
  }, 20_000);
});
