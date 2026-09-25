import { canonicalizeRdfObjectTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Take in a public copy received from another node as this node's own.
 *
 * The copy arrives as N-Quads text. Its literals can carry escapes, such as
 * `\u` escapes for non-ASCII text or a UTF-16 surrogate pair for an emoji,
 * which the triple store decodes on write. Each literal is rewritten to the
 * form the store returns (canonicalizeRdfObjectTerm) before the node persists
 * the copy or fingerprints it with workspacePublicQuadsDigest, so the
 * fingerprint it records equals the one the finalization check recomputes
 * from the store.
 *
 * The fingerprint function itself stays byte-exact. Call this only where a
 * received copy becomes the node's own, after the copy has been checked as
 * received: the StorageACK, SWM share and gossip publish receivers. A check of
 * a hash against bytes as given (a peer's advertised digest, a stored
 * snapshot) must not call it. `test/incoming-public-copy-boundary.test.ts`
 * pins the callers.
 */
export function acceptIncomingPublicQuads<T extends Quad>(quads: readonly T[]): T[] {
  return quads.map((quad) => {
    const object = canonicalizeRdfObjectTerm(quad.object);
    return object === quad.object ? quad : { ...quad, object };
  });
}
