import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import type { AtomicAssetReplacement } from '../../src/atomic-asset-group.js';
import { readGraphDeltaDelete, readGraphInsertQuads } from '../../src/read-graph/statements.js';
import { has, P, planned, q, readGraphWriteSuite, sentOverFetch } from './read-graph-write-suite.js';

/**
 * Live checks that BlazegraphStore sends a write's read-graph operations in
 * the same request as its data change (see `read-graph-write-suite.ts`), plus
 * Blazegraph's own: the direct form of `replaceAssetGroup`, and one update
 * request at a time.
 */
export function blazegraphReadGraphWriteTests(url: string): void {
  /** Wait until Blazegraph's status page lists a running request whose text holds `marker`. */
  async function untilRunningOnServer(marker: string): Promise<void> {
    const status = `${url.replace(/\/namespace\/[^/]+\/sparql\/?$/, '')}/status?showQueries`;
    const deadline = performance.now() + 10_000;
    while (!(await (await fetch(status)).text()).includes(marker)) {
      if (performance.now() > deadline) throw new Error('The first update never showed as running on the server');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  readGraphWriteSuite({
    name: 'Blazegraph (live server)',
    adapter: 'blazegraph',
    open: async () => new BlazegraphStore(url, { timeout: 30_000 }),
    requests: sentOverFetch(),
  }, ({ store, inScenario, graph, render, statements }) => {
    it('replaceAssetGroup in one direct update replaces what the graph held', () => inScenario(async (s) => {
      const asset = (objects: string[]): AtomicAssetReplacement => ({
        graphUri: s.G4, graphQuads: objects.map((object) => ({ ...q('g', 'x', s.G4), object })),
        metaGraphUri: s.META, metadataSubject: `${s.base}/asset/4`,
        metadataQuads: [{ subject: `${s.base}/asset/4`, predicate: P, object: '"meta"', graph: s.META }],
      });
      await s.maintained(s.reference(s.G4, s.META), (o) => store().replaceAssetGroup([asset(['"seven"'])], o));
      expect(has(await s.readGraph(), 'seven')).toBe(true);
      // Two literals Blazegraph may store as one term select the direct update instead of the bulk plan.
      await s.maintained(s.reference(s.G4, s.META), (o) => store().replaceAssetGroup([asset(['"eight"@en', '"eight"@EN'])], o));
      expect(has(await graph(s.G4), 'seven')).toBe(false);
      expect(has(await s.readGraph(), 'seven')).toBe(false);
      expect((await graph(s.G4)).some((t) => t.includes('"eight"'))).toBe(true);
      expect((await s.readGraph()).some((t) => t.includes('"eight"'))).toBe(true);
    }));

    it('runs one update request at a time: concurrent removals of the last two copies leave R right', () =>
      inScenario(async (s) => {
        for (let round = 0; round < 3; round += 1) {
          const shared = q(`shared-${round}`, 'last', s.G1);
          const copy = { ...shared, graph: s.G3 };
          await store().insert([shared, copy, ...readGraphInsertQuads(s.R, [shared])]);
          // A slow first operation keeps the first request running; its marker shows it on the status page.
          const marker = `overlap${randomUUID().replaceAll('-', '')}`;
          const slow = `INSERT { GRAPH <${s.SCRATCH}> { ?a <${P}> ?b } } WHERE { `
            + `VALUES ?a { ${Array.from({ length: 400 }, (_, i) => `"${marker}${i}"`).join(' ')} } `
            + `VALUES ?b { ${Array.from({ length: 400 }, (_, i) => `"b${i}"`).join(' ')} } }`;
          const finished: string[] = [];
          const firstWrite = store().delete([shared], planned(s.plan([slow], [readGraphDeltaDelete(s.target, [shared], render)!])))
            .then(() => { finished.push('first'); });
          // The second request is sent only once the server shows the first one running.
          await untilRunningOnServer(marker);
          // Sent past the adapter's own scheduler, so only the server can make it wait.
          const secondWrite = fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
            body: [statements.deleteData([copy])!.update, readGraphDeltaDelete(s.target, [copy], render)!].join('\n;\n'),
          }).then(async (response) => {
            const text = await response.text();
            if (!response.ok) throw new Error(`second request failed (${response.status}): ${text.slice(0, 200)}`);
            finished.push('second');
          });
          await Promise.all([firstWrite, secondWrite]);
          // The short second request still finished after the long first one.
          expect(finished).toEqual(['first', 'second']);
          expect((await s.readGraph()).some((t) => t.startsWith(`urn:rg-int:shared-${round} `))).toBe(false);
          expect(await s.readGraph()).toEqual(await s.union());
          await store().dropGraph(s.SCRATCH);
        }
      }), 60_000);
  });
}
