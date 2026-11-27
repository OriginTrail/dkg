import type { Quad } from '@origintrail-official/dkg-storage';
import { normalizeGraphScopedHex32 } from '../src/sync/graph-scoped-root.js';

/** Hand-built verified-asset fixtures must state the same root as their metadata. */
export function fixtureRoot(metadata: readonly Quad[]): string {
  const root = metadata.find(quad => quad.predicate === 'http://dkg.io/ontology/merkleRoot');
  if (!root) throw new Error('Verified asset fixture has no root');
  return normalizeGraphScopedHex32(root.object, 'fixture root');
}
