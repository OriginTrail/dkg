import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

/**
 * Regression for the PR #1714 torn-snapshot review finding: the CACHED
 * responder snapshot used to be assembled from MULTIPLE independent
 * `ORDER BY ?g ?s ?p ?o OFFSET/LIMIT` store queries (500-row internal pages).
 * A write landing between two internal pages shifted the OFFSET window, so the
 * memoized snapshot could contain a duplicated row and miss another — and then
 * serve that torn view for the entire sync session. The build now issues
 * exactly ONE bounded query (`LIMIT maxRows + 1`, see loadBoundedSnapshot),
 * which the store executes against a single consistent view, restoring the
 * base single-query consistency guarantee for cacheable snapshots.
 *
 * The oversized fallback still pages by OFFSET per wire request; that
 * pre-existing behavior class is covered by
 * sync-responder-oversized-fallback.test.ts and is out of scope here.
 */
describe('sync responder cached snapshot consistency under concurrent writes', () => {
  it('builds the cached snapshot with one store query so mid-build writes cannot tear it', async () => {
    const store = new OxigraphStore();
    const cgId = 'snapshot-consistency';
    const dataGraph = `did:dkg:context-graph:${cgId}/context/1`;
    // Larger than the removed 500-row internal build page, so the OLD builder
    // would have needed three internal OFFSET queries for this snapshot.
    const TOTAL_ROWS = 1_200;
    const pad = (index: number) => index.toString().padStart(4, '0');
    const rows: Quad[] = Array.from({ length: TOTAL_ROWS }, (_, index) => ({
      graph: dataGraph,
      subject: `urn:snap:${pad(index)}`,
      predicate: `${DKG_NS}label`,
      object: `"row-${pad(index)}"`,
    }));
    await store.insert(rows);

    // Count snapshot row-set reads and inject a concurrent write AFTER every
    // one, i.e. between successive query() calls. The injected subject sorts
    // BEFORE every `urn:snap:` subject, which under the old multi-page build
    // shifted the next page's OFFSET window by one: the row at the previous
    // page boundary was served twice and the last row fell out of the window.
    const originalQuery = store.query.bind(store);
    let snapshotRowQueries = 0;
    store.query = (async (sparql: string) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      const isSnapshotRowQuery =
        /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
        normalized.includes(`VALUES ?g { <${dataGraph}>`) &&
        normalized.includes('ORDER BY ?g ?s ?p ?o');
      const result = await originalQuery(sparql);
      if (isSnapshotRowQuery) {
        snapshotRowQueries += 1;
        // The single-read build must issue this from offset zero; a second
        // call would already prove the build is paging again.
        expect(normalized).toContain('OFFSET 0');
        await store.insert([{
          graph: dataGraph,
          subject: `urn:aaa:injected-${snapshotRowQueries}`,
          predicate: `${DKG_NS}label`,
          object: `"injected-${snapshotRowQueries}"`,
        }]);
      }
      return result;
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { syncPageSize: 400 });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 400,
      syncSessionId: 'snapshot-consistency-session',
    };

    const collected: string[] = [];
    for (let offset = 0, page = 0; page < 10; page += 1, offset += 400) {
      const out = await cap.invoke({ ...base, offset });
      const lines = linesFromNquads(out);
      collected.push(...lines);
      if (lines.length < 400) break;
    }

    // The cached snapshot was materialized by exactly ONE store query; later
    // wire pages were sliced from the memo without touching the store again.
    expect(snapshotRowQueries).toBe(1);

    // The assembled session view is exactly the store's row set at read time:
    // every original row exactly once — no duplicates (unique (g,s,p,o) count
    // equals the row count), no skipped rows, and no rows from the write that
    // landed after the single consistent read.
    expect(collected).toHaveLength(TOTAL_ROWS);
    expect(new Set(collected).size).toBe(TOTAL_ROWS);
    expect(collected.every((line) => line.startsWith('<urn:snap:'))).toBe(true);
    const joined = collected.join('\n');
    expect(joined).toContain('"row-0000"');
    // The old torn view duplicated the row at the 500-row internal page
    // boundary and dropped the final row; both must be present exactly once.
    expect(joined).toContain('"row-0499"');
    expect(joined).toContain('"row-0500"');
    expect(joined).toContain('"row-1199"');
    expect(joined).not.toContain('injected');
  });
});
