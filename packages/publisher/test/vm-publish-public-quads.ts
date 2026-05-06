import type { Quad } from '@origintrail-official/dkg-storage';
import { TrustLevel } from '@origintrail-official/dkg-core';
import { autoPartition } from '../src/auto-partition.js';

const TRUST_PRED = 'http://dkg.io/ontology/trustLevel';
const TRUST_SELF =
  `"${TrustLevel.SelfAttested}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

/** Mirrors DKGPublisher stamping before flat KC merkle (publish + update). */
export function vmPublishPublicQuads(userQuads: Quad[]): Quad[] {
  const kaMap = autoPartition(userQuads.map((q) => ({ ...q, graph: q.graph ?? '' })));
  for (const root of kaMap.keys()) {
    kaMap.get(root)!.push({
      subject: root,
      predicate: TRUST_PRED,
      object: TRUST_SELF,
      graph: '',
    });
  }
  return [...kaMap.values()].flat();
}
