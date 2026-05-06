import type { Quad } from '@origintrail-official/dkg-storage';
import { autoPartition } from '../src/auto-partition.js';

/** Same partition+flatten as DKGPublisher uses for the flat KC merkle root (trust literals omitted). */
export function vmPublishPublicQuads(userQuads: Quad[]): Quad[] {
  const kaMap = autoPartition(userQuads.map((q) => ({ ...q, graph: q.graph ?? '' })));
  return [...kaMap.values()].flat();
}
