// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { literalValue, parseInteger } from './finalized-swm-twin-literals.js';

export type FinalizedTwinSwmHead =
  | { kind: 'absent' }
  | { kind: 'inexact' }
  | { kind: 'exact'; version: bigint; kaUal: string; assertionGraph: string; shareOperationId: string };

/** One read preserves absence, partial/ambiguous rows and exact head facts. */
export async function readFinalizedTwinSwmHead(
  store: TripleStore,
  input: Readonly<{ metaGraph: string; headSubject: string }>,
): Promise<FinalizedTwinSwmHead> {
  const result = await store.query(
    `SELECT DISTINCT ?p ?o WHERE { GRAPH <${assertSafeIri(input.metaGraph)}> { `
      + `<${assertSafeIri(input.headSubject)}> ?p ?o } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readHead' },
  );
  if (result.type !== 'bindings') return { kind: 'inexact' };
  if (result.bindings.length === 0) return { kind: 'absent' };
  const values = new Map<string, Set<string>>();
  for (const row of result.bindings) {
    if (!row['p'] || row['o'] === undefined) return { kind: 'inexact' };
    const objects = values.get(row['p']) ?? new Set<string>();
    objects.add(row['o']); values.set(row['p'], objects);
  }
  const one = (name: string): string | undefined => {
    const objects = values.get(`http://dkg.io/ontology/${name}`);
    return objects?.size === 1 ? [...objects][0] : undefined;
  };
  const version = parseInteger(one('assertionVersion'));
  const kaUal = one('kaUal'), assertionGraph = one('assertionGraph');
  const shareOperationId = literalValue(one('shareOperationId'))?.trim();
  return version === null || !kaUal || !assertionGraph || !shareOperationId
    ? { kind: 'inexact' }
    : { kind: 'exact', version, kaUal, assertionGraph, shareOperationId };
}
