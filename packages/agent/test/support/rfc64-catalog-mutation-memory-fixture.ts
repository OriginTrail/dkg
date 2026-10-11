/**
 * What the catalog mutation memory's unit tests share: scopes, real author seals, applied-head
 * records with the successors that committed them, and a durable store that only counts.
 */
import {
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { beforeAll, vi } from 'vitest';

import type {
  Rfc64CatalogMutationStateV1,
  Rfc64SignedCatalogSuccessorV1,
} from '../../src/internal/catalog-mutation-memory.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../../src/rfc64/persistence-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  compareRfc64PublicCatalogSuccessorAssetsByKaIdV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from '../../src/rfc64/public-catalog-successor-asset-v1.js';
import { producerSealV1 } from './rfc64-successor-producer-fixture.js';

export const SCOPE_A = `0x${'a1'.repeat(32)}` as Digest32V1;
export const SCOPE_B = `0x${'b2'.repeat(32)}` as Digest32V1;
export const SCOPE_C = `0x${'c3'.repeat(32)}` as Digest32V1;
export const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
export const POLICY = `0x${'d4'.repeat(32)}`;
export const OUTCOME = { transfer: {}, projection: {} } as never;

export function digest(byte: number): Digest32V1 {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Digest32V1;
}

export const DELEGATION_DIGEST = digest(240);
export const AUTHORIZATION = Object.freeze({
  catalogIssuerDelegation: { objectDigest: DELEGATION_DIGEST },
  parentAuthorAgentEvidence: null,
}) as never;

/** Real author seals, by KA number and assertion version: `advance` compares their digests. */
const SEALS = new Map<string, CanonicalGraphScopedAuthorSealV1>();

beforeAll(async () => {
  for (const kaNumber of [1, 2, 3, 4]) {
    for (const version of ['1', '2']) {
      SEALS.set(`${kaNumber}@${version}`, await producerSealV1(BigInt(kaNumber), version));
    }
  }
});

export function asset(kaNumber: number, bytes = 16, version = '1'): Rfc64PublicCatalogSuccessorAssetInputV1 {
  return Object.freeze({
    assertionCoordinate: `row-${kaNumber}` as never,
    projectionBytes: new Uint8Array(bytes),
    seal: SEALS.get(`${kaNumber}@${version}`)!,
  });
}

export function applied(
  scope: Digest32V1,
  head: number,
  overrides: Partial<AppliedCatalogHeadSnapshotV1> = {},
): AppliedCatalogHeadSnapshotV1 {
  return Object.freeze({
    catalogScopeDigest: scope,
    authorAddress: AUTHOR,
    currentCatalogHeadDigest: digest(head),
    appliedInventoryDigest: digest(head + 100),
    catalogVersion: String(head) as never,
    inventoryRowCount: '2' as never,
    ...overrides,
  });
}

/** The rows a successor reports for `assets`, as the agent derives them from its signed bucket. */
export function signedRows(assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[]) {
  return [...assets].sort(compareRfc64PublicCatalogSuccessorAssetsByKaIdV1).map(({ seal }) => ({
    kaId: seal.reservedKaId,
    catalogRowDigest: digest(1),
    bundleDigest: digest(2),
    contentDigest: digest(3),
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    activatedTripleCount: 2,
    contentByteLength: '10',
    bundleByteLength: '20',
    kaUal: seal.kaUal,
  })) as unknown as Rfc64SignedCatalogSuccessorV1['assets'];
}

/** The applied-head record and the successor one own CAS leaves for exactly `assets`. */
export function committed(
  scope: Digest32V1,
  head: number,
  assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[],
) {
  const rows = signedRows(assets);
  return {
    applied: applied(scope, head, {
      inventoryRowCount: String(rows.length) as never,
      appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: scope, rows }),
    }),
    successor: {
      headObjectDigest: digest(head),
      signatureVariantDigest: digest(77),
      assets: rows,
    } satisfies Rfc64SignedCatalogSuccessorV1,
  };
}

export function stateOf(
  current: AppliedCatalogHeadSnapshotV1,
  assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[] = [asset(1), asset(2)],
): Rfc64CatalogMutationStateV1 {
  return Object.freeze({
    current,
    previousHead: Object.freeze({
      objectDigest: current.currentCatalogHeadDigest,
      signatureVariantDigest: digest(250),
    }),
    catalogIssuerAuthorization: AUTHORIZATION,
    assets: Object.freeze([...assets]),
    expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
  });
}

/**
 * An inventory whose applied heads the test moves, a durable read that only counts, and control
 * objects and bundles that are there unless the test takes them away.
 */
export function durableStore(assetsOf: (current: AppliedCatalogHeadSnapshotV1) =>
  readonly Rfc64PublicCatalogSuccessorAssetInputV1[] = () => [asset(1), asset(2)]) {
  const heads = new Map<string, AppliedCatalogHeadSnapshotV1>();
  const missing = new Set<string>();
  const bundles = new Map<string, Uint8Array>();
  const controlObjectReads: string[] = [];
  const readVerified = vi.fn(async (_persistence: Rfc64PersistenceV1, current: AppliedCatalogHeadSnapshotV1) => (
    stateOf(current, assetsOf(current))
  ));
  const persistence = {
    inventory: {
      readAppliedCatalogHeadV1: (scope: Digest32V1, author: string) => heads.get(`${scope}\n${author}`) ?? null,
    },
    controlObjects: {
      getVerifiedObjectByDigest: async ({ objectDigest }: { objectDigest: string }) => {
        controlObjectReads.push(objectDigest);
        return missing.has(objectDigest) ? null : { envelope: {}, issuerSignature: {} };
      },
    },
    kaBundles: {
      readKaBundleByDigest: async (blobDigest: string) => bundles.get(blobDigest) ?? null,
    },
  } as unknown as Rfc64PersistenceV1;
  return {
    persistence,
    readVerified,
    missing,
    bundles,
    controlObjectReads,
    apply(head: AppliedCatalogHeadSnapshotV1 | null, scope: Digest32V1 = SCOPE_A): void {
      if (head === null) heads.delete(`${scope}\n${AUTHOR}`);
      else heads.set(`${scope}\n${AUTHOR}`, head);
    },
  };
}
