// SPDX-License-Identifier: Apache-2.0
import { canonicalQuadKey } from './quad-key.js';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Provider history cannot union into a locally owned graph-scoped operation.
 * Include orphan/partial operation rows, even when no wire head references them;
 * admitted descriptor operations have already been settled under their KA lock.
 */
export async function filterRecoveredBulkMetadata(store: TripleStore, rows: readonly Quad[], withheld: readonly Quad[] = []): Promise<Quad[]> {
  const keys = new Set(withheld.map(canonicalQuadKey));
  rows = rows.filter(row => !keys.has(canonicalQuadKey(row)));
  const pairs = [...new Map(rows.filter(row => row.subject.startsWith('urn:dkg:share:'))
    .map(row => [JSON.stringify([row.graph, row.subject]), { graph: row.graph, subject: row.subject }])).values()];
  const protectedSubjects = new Set<string>();
  for (let offset = 0; offset < pairs.length; offset += 256) {
    const page = pairs.slice(offset, offset + 256);
    const result = await store.query(`SELECT DISTINCT ?g ?s WHERE {
      VALUES (?g ?s) { ${page.map(pair => `(<${assertSafeIri(pair.graph)}> <${assertSafeIri(pair.subject)}>)`).join(' ')} }
      GRAPH ?g {
        { ?s <http://dkg.io/ontology/contentScopeVersion> 2 }
        UNION { ?head <http://dkg.io/ontology/assertionGraph> ?graph ; <http://dkg.io/ontology/shareOperationId> ?id . ?s <http://dkg.io/ontology/shareOperationId> ?id }
      }
    }`, { priority: 'background', source: 'agent.swmRecovery.bulkOperationOwnership' });
    if (result.type !== 'bindings') throw new Error('Recovered operation ownership is unavailable');
    for (const row of result.bindings) protectedSubjects.add(JSON.stringify([row['g'], row['s']]));
  }
  return rows.filter(row => !protectedSubjects.has(JSON.stringify([row.graph, row.subject])));
}
