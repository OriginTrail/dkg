import { describe, it, expect } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { readSwmDataPage } from '../src/sync/responder/graph-plan.js';
import { createResponderSyncRowListMemo } from '../src/sync/responder/snapshot-cache.js';

/**
 * Regression for the `/dkg/x/sync` responder crash:
 * `[ProtocolRouter] handler error on /dkg/x/sync from <peer>: Maximum call
 * stack size exceeded`.
 *
 * The TTL-cutoff shared-memory data path formerly materialised every fresh row
 * of a data graph into one array before applying its snapshot budget. When a
 * graph exceeded V8's argument-spread limit (~1.25e5), the responder crashed.
 *
 * This drives the real paged path against a logical 200k-row graph and proves
 * no individual store response or responder page exceeds 500 rows.
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
        if (sparql.includes('SELECT DISTINCT ?g ?s ?p ?o')) {
          const offset = Number(/OFFSET (\d+)/.exec(sparql)?.[1] ?? 0);
          const limit = Number(/LIMIT (\d+)/.exec(sparql)?.[1] ?? rowCount);
          return {
            type: 'bindings' as const,
            bindings: bigRows.slice(offset, offset + limit),
          };
        }
        // Legacy helper shape retained defensively; the new snapshot loader
        // reaches the combined store-side FILTER EXISTS query above.
        if (sparql.includes('WorkspaceOperation')) {
          return { type: 'bindings' as const, bindings: [{ root }] };
        }
        return { type: 'bindings' as const, bindings: [] };
      },
    } as unknown as TripleStore;

    // No explicit budget still gets the hard 10k/32MiB build cap. Once crossed,
    // this session is remembered as store-paged and never retries a full load.
    const memo = createResponderSyncRowListMemo(120_000, 32, { phase: 'durable_data' });

    let received = 0;
    for (let offset = 0; offset < rowCount; offset += 500) {
      const rows = await readSwmDataPage({
        store,
        graphList: [dataGraph, metaGraph],
        registeredSubGraphNames: [],
        contextGraphId: cg,
        cutoffIso: '2020-01-01T00:00:00.000Z',
        offset,
        limit: 500,
        rowListMemo: memo,
        rowListCacheKey: `${cg}:swm-data`,
        refreshRowList: offset === 0,
      });
      expect(rows.length).toBeLessThanOrEqual(500);
      expect(rows.every((r) => r.s === root)).toBe(true);
      received += rows.length;
    }

    expect(received).toBe(rowCount);
  }, 20_000);
});
