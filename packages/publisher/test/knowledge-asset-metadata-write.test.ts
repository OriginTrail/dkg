// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { convergeKnowledgeAssetMetadataRows } from '../src/knowledge-asset-metadata-write.js';
import { materializedVersionQuad } from '../src/metadata.js';

const META = 'urn:test:exact-materialization-meta';
const SUBJECT = 'urn:test:exact-materialization-ka';
const prior = { blockNumber: 10, txIndex: 2 };
const ordered = (rows: readonly Quad[]) => rows.map(row => JSON.stringify(row)).sort();

describe('exact KA metadata convergence', () => {
  it.each(['omit', 'retain', 'replace'] as const)(
    'converges to precisely the requested rows when the caller chooses to %s an ordering fence',
    async choice => {
      const store = new OxigraphStore();
      const other = { subject: 'urn:other-ka', predicate: 'urn:policy', object: '"unchanged"', graph: META };
      const rows = [{ subject: SUBJECT, predicate: 'urn:policy', object: '"new"', graph: META }];
      if (choice !== 'omit') rows.push(materializedVersionQuad(META, SUBJECT,
        choice === 'retain' ? prior : { blockNumber: 11, txIndex: 0 }));
      try {
        await store.insert([other, materializedVersionQuad(META, SUBJECT, prior),
          { subject: SUBJECT, predicate: 'urn:policy', object: '"old"', graph: META }]);
        for (let retry = 0; retry < 2; retry++) {
          await convergeKnowledgeAssetMetadataRows(store, META, SUBJECT, rows);
          const result = await store.query(`CONSTRUCT { <${SUBJECT}> ?p ?o } WHERE {
            GRAPH <${META}> { <${SUBJECT}> ?p ?o } }`);
          expect(result.type).toBe('quads');
          if (result.type === 'quads') {
            expect(ordered(result.quads.map(row => ({ ...row, graph: META })))).toEqual(ordered(rows));
          }
          expect(await store.query(`ASK { GRAPH <${META}> { <urn:other-ka> <urn:policy> "unchanged" } }`))
            .toMatchObject({ value: true });
        }
      } finally { await store.close(); }
    },
  );
});
