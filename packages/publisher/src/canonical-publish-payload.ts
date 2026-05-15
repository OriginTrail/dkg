// Shared canonicalization for the publish flow. Both `agent.publishAsync`
// (enqueue-time) and `DKGPublisher.publish` (processNext-time) compute
// `kcMerkleRoot` via this single function so the EIP-712 seal binds to
// the same bytes the publisher submits.

import type { Quad } from '@origintrail-official/dkg-storage';
import { autoPartition } from './auto-partition.js';
import { computeFlatKCRootV10, computePrivateRootV10 } from './merkle.js';

export interface CanonicalManifestEntry {
  readonly rootEntity: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot: Uint8Array | undefined;
  readonly privateTripleCount: number;
}

export interface CanonicalPublishPayload {
  readonly skolemizedPublicQuads: Quad[];
  readonly privateRoots: Uint8Array[];
  readonly kcMerkleRoot: Uint8Array;
  readonly manifestEntries: ReadonlyArray<CanonicalManifestEntry>;
}

export function canonicalPublishPayload(
  quads: Quad[],
  privateQuads: Quad[] = [],
): CanonicalPublishPayload {
  const kaMap = autoPartition(quads);

  const manifestEntries: CanonicalManifestEntry[] = [];
  for (const [rootEntity, publicForRoot] of kaMap) {
    const entityPrivateQuads = privateQuads.filter(
      (qq) =>
        qq.subject === rootEntity ||
        qq.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    manifestEntries.push({
      rootEntity,
      publicTripleCount: publicForRoot.length,
      privateMerkleRoot: entityPrivateQuads.length > 0
        ? computePrivateRootV10(entityPrivateQuads)
        : undefined,
      privateTripleCount: entityPrivateQuads.length,
    });
  }

  const skolemizedPublicQuads = [...kaMap.values()].flat();
  const privateRoots = manifestEntries
    .map((m) => m.privateMerkleRoot)
    .filter((r): r is Uint8Array => r != null);
  const kcMerkleRoot = computeFlatKCRootV10(skolemizedPublicQuads, privateRoots);

  return {
    skolemizedPublicQuads,
    privateRoots,
    kcMerkleRoot,
    manifestEntries,
  };
}
