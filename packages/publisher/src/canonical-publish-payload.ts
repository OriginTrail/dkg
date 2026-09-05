// Shared canonicalization for the publish flow. Both `agent.publishAsync`
// (enqueue-time) and `DKGPublisher.publish` (processNext-time) compute
// `kcMerkleRoot` via this single function so the EIP-712 seal binds to
// the same bytes the publisher submits.

import type { Quad } from '@origintrail-official/dkg-storage';
import { skolemizeByEntity } from './auto-partition.js';
import { computeFlatKCRootV10, computePrivateRootV10 } from './merkle.js';
import {
  splitTrustedGeneratedCatalogRootMap,
  type TrustedCatalogTripleKeys,
} from './catalog-trust.js';

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
  readonly generatedCatalogRootEntities: ReadonlyArray<string>;
}

export interface CanonicalPublishPayloadOptions {
  /**
   * Exact generated public-catalog triples that must ride in the KC Merkle root
   * but must not become user KA manifest roots. This is intentionally an exact
   * subject/predicate/object allow-list, not a prefix or predicate bypass.
   */
  readonly trustedNonManifestCatalogTriples?: TrustedCatalogTripleKeys;
}

export function canonicalPublishPayload(
  quads: Quad[],
  privateQuads: Quad[] = [],
  options?: CanonicalPublishPayloadOptions,
): CanonicalPublishPayload {
  const kaMap = skolemizeByEntity(quads);
  const {
    contentRootMap,
    generatedCatalogRootEntities,
  } = splitTrustedGeneratedCatalogRootMap(
    kaMap,
    options?.trustedNonManifestCatalogTriples,
  );
  const generatedCatalogRootSet = new Set(generatedCatalogRootEntities);
  const privateByRoot = new Map<string, Quad[]>();
  const skolemBoundary = '/.well-known/genid/';
  const addPrivateQuad = (root: string, quad: Quad): void => {
    let bucket = privateByRoot.get(root);
    if (!bucket) privateByRoot.set(root, bucket = []);
    bucket.push(quad);
  };
  for (const quad of privateQuads) {
    if (kaMap.has(quad.subject)) addPrivateQuad(quad.subject, quad);
    // The old contract attributed a private row to every known root for which
    // subject.startsWith(root + '/.well-known/genid/'). Check only prefixes at
    // actual skolem boundaries, preserving roots that themselves end in
    // `/.well-known/genid` and overlapping known roots without an O(roots ×
    // privateQuads) scan.
    let boundary = quad.subject.indexOf(skolemBoundary);
    while (boundary >= 0) {
      const candidate = quad.subject.slice(0, boundary);
      if (kaMap.has(candidate)) addPrivateQuad(candidate, quad);
      // Advance one byte so adjacent/nested markers can share the separating
      // slash (a valid root may end in `/.well-known/genid`).
      boundary = quad.subject.indexOf(skolemBoundary, boundary + 1);
    }
  }

  const manifestEntries: CanonicalManifestEntry[] = [];
  for (const rootEntity of generatedCatalogRootSet) {
    const hiddenPrivateQuads = privateByRoot.get(rootEntity) ?? [];
    if (hiddenPrivateQuads.length > 0) {
      throw new Error(
        `Generated catalog subject "${rootEntity}" has private triples; ` +
        'refusing to exclude it from the KA manifest',
      );
    }
  }

  for (const [rootEntity, publicForRoot] of contentRootMap) {
    const entityPrivateQuads = privateByRoot.get(rootEntity) ?? [];
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
    generatedCatalogRootEntities,
  };
}
