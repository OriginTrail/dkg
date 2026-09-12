// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  decodeOpaqueKaBundleV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedCatalogSealBindingV1,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type NetworkIdV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type VerifiedCatalogSealBindingSnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import { unpackKnowledgeAssetId } from '../ka-identity.js';
import { mapWithConcurrency } from '../map-with-concurrency.js';
import {
  loadExactAppliedCatalogRowsV1,
  readValidatedRfc64AppliedCatalogHeadV1,
} from './applied-catalog-authority-transition-v1.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './inventory-v1/index.js';
import type { Rfc64KaBundleOperationsV1 } from './ka-bundle-store-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import {
  composeRfc64PublicCatalogInventoryEvidenceRowV1,
  computeRfc64AppliedInventoryDigestV1,
  type Rfc64PublicCatalogInventoryEvidenceRowV1,
} from './public-catalog-inventory-completeness-v1.js';

const VERIFIED_CATALOG_BUNDLE_READ_CONCURRENCY_V1 = 8;

export interface ReadVerifiedAppliedCatalogClosureInputV1 {
  readonly appliedHead: AppliedCatalogHeadSnapshotV1;
  readonly controlObjects: Pick<
    Rfc64ControlObjectOperationsV1,
    'getVerifiedObjectByDigest'
  >;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly kaBundles: Pick<Rfc64KaBundleOperationsV1, 'readKaBundleByDigest'>;
  readonly trustedCatalogScope: Readonly<AuthorCatalogScopeV1>;
  readonly verifyIssuerSignature?: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

export interface VerifiedAppliedCatalogClosureRowV1 {
  /** Exact uint96 asset number; never narrowed through JavaScript Number. */
  readonly kaNumber: bigint;
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly bundleBinding: VerifiedCatalogSealBindingSnapshotV1;
  readonly inventoryEvidence: Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>;
}

export interface VerifiedAppliedCatalogClosureV1 {
  readonly appliedHead: Readonly<AppliedCatalogHeadSnapshotV1>;
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  readonly rows: readonly Readonly<VerifiedAppliedCatalogClosureRowV1>[];
  readonly inventoryEvidence: Readonly<{
    readonly catalogScopeDigest: AppliedCatalogHeadSnapshotV1['catalogScopeDigest'];
    readonly inventoryRowCount: AppliedCatalogHeadSnapshotV1['inventoryRowCount'];
    readonly inventoryDigest: AppliedCatalogHeadSnapshotV1['appliedInventoryDigest'];
    readonly rows: readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[];
  }>;
}

/**
 * Re-establish the complete durable applied-catalog closure from canonical
 * production objects. The result binds the applied ref, signed head/rows,
 * durable KA bundles, deployment-pinned seals, and applied inventory digest.
 */
export async function readVerifiedAppliedCatalogClosureV1(
  input: ReadVerifiedAppliedCatalogClosureInputV1,
): Promise<Readonly<VerifiedAppliedCatalogClosureV1>> {
  const verifyIssuerSignature = input.verifyIssuerSignature
    ?? verifyControlEnvelopeIssuerSignatureV1;
  const storedHead = await readValidatedRfc64AppliedCatalogHeadV1({
    appliedHead: input.appliedHead,
    controlObjects: input.controlObjects,
    verifyIssuerSignature,
  });
  const head = storedHead.envelope;
  const catalogScope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  if (
    computeAuthorCatalogScopeDigestV1(input.trustedCatalogScope)
      !== input.appliedHead.catalogScopeDigest
    || input.trustedCatalogScope.authorAddress !== input.appliedHead.authorAddress
  ) {
    throw new Error('applied catalog head differs from its signed SWM proof closure');
  }
  const catalogRows = await loadExactAppliedCatalogRowsV1(
    input.controlObjects,
    storedHead,
    input.trustedCatalogScope,
    verifyIssuerSignature,
  );
  const rows = await mapWithConcurrency(
    catalogRows,
    VERIFIED_CATALOG_BUNDLE_READ_CONCURRENCY_V1,
    async (row): Promise<Readonly<VerifiedAppliedCatalogClosureRowV1>> => {
      const bundleBytes = await input.kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
      if (bundleBytes === null) throw new Error('signed catalog row has no durable KA bundle');
      const bundle = decodeOpaqueKaBundleV1(bundleBytes);
      if (
        bundle.blobDigest !== row.transfer.blobDigest
        || bundle.projectionDigest !== row.projectionDigest
        || bundleBytes.byteLength.toString() !== row.transfer.byteLength
      ) {
        throw new Error('durable KA bundle differs from its signed catalog row');
      }
      const bundleBinding = readVerifiedCatalogSealBindingV1(verifyCatalogSealBindingV1(
        input.trustedCatalogScope,
        row,
        bundle.sealBytes,
        input.deployment,
      ));
      const identity = unpackKnowledgeAssetId(BigInt(row.kaId));
      const kaNumber = identity.kaNumber;
      if (
        identity.agentAddress !== input.trustedCatalogScope.authorAddress
        || bundleBinding.seal.kaUal
          !== `did:dkg:${input.trustedCatalogScope.networkId}/${identity.agentAddress}/${kaNumber}`
      ) {
        throw new Error('signed catalog row identity differs from its verified bundle binding');
      }
      const inventoryEvidence = composeRfc64PublicCatalogInventoryEvidenceRowV1({
        activatedTripleCount: bundleBinding.seal.publicTripleCount,
        bundleDigest: row.transfer.blobDigest,
        catalogRowDigest: bundleBinding.catalogRowDigest,
        contentDigest: row.projectionDigest,
        kaId: row.kaId,
        kaUal: bundleBinding.seal.kaUal,
        sealDigest: bundleBinding.sealDigest,
      });
      return Object.freeze({
        kaNumber,
        row,
        bundleBinding,
        inventoryEvidence,
      });
    },
  );
  // loadExactAppliedCatalogRowsV1 has already bound this exact row set to the
  // signed head, whose totalRows was bound to the applied snapshot above.
  const inventoryRows = Object.freeze(rows.map(({ inventoryEvidence }) => inventoryEvidence));
  const inventoryDigest = computeRfc64AppliedInventoryDigestV1({
    catalogScopeDigest: input.appliedHead.catalogScopeDigest,
    rows: inventoryRows,
  });
  if (inventoryDigest !== input.appliedHead.appliedInventoryDigest) {
    throw new Error('signed catalog closure differs from the durable applied inventory digest');
  }
  return Object.freeze({
    appliedHead: Object.freeze({ ...input.appliedHead }),
    head,
    catalogScope: Object.freeze({ ...catalogScope }),
    rows: Object.freeze(rows),
    inventoryEvidence: Object.freeze({
      catalogScopeDigest: input.appliedHead.catalogScopeDigest,
      inventoryRowCount: input.appliedHead.inventoryRowCount,
      inventoryDigest,
      rows: inventoryRows,
    }),
  });
}

export type Rfc64PrivateReleaseProofReaderV1 = (
  input: Readonly<{
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>;
  }>,
) => Promise<Readonly<VerifiedAppliedCatalogClosureV1>>;

export interface RegisterRfc64PrivateReleaseProofReaderOptionsV1 {
  readonly owner: object;
  readonly persistence: Pick<
    Rfc64PersistenceV1,
    'controlObjects' | 'inventory' | 'kaBundles'
  >;
  readonly assertTrustedNetwork: (networkId: NetworkIdV1) => void;
  readonly resolveDeployment: (
    networkId: NetworkIdV1,
    signal: AbortSignal,
  ) => Promise<CatalogSealDeploymentProfileV1>;
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

// `node --import tsx` can load the source gate beside the package build used by
// its daemon children. Share only the private WeakMap across those two module
// instances; no proof capability is attached to DKGAgent or its public types.
const PROOF_READER_REGISTRY = Symbol.for(
  '@origintrail-official/dkg-agent/internal/rfc64-private-release-proof-reader-registry-v1',
);
const proofReaders = resolveSharedProofReaderRegistryV1();

/** Inject one internal, owner-bound proof capability for the source gate. */
export function registerRfc64PrivateReleaseProofReaderV1(
  options: RegisterRfc64PrivateReleaseProofReaderOptionsV1,
): void {
  const {
    owner,
    persistence,
    assertTrustedNetwork,
    resolveDeployment,
    verifyIssuerSignature,
  } = options;
  const reader: Rfc64PrivateReleaseProofReaderV1 = async ({ trustedCatalogScope }) => {
    assertTrustedNetwork(trustedCatalogScope.networkId);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(trustedCatalogScope);
    const appliedHead = persistence.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      trustedCatalogScope.authorAddress,
    );
    if (appliedHead === null) {
      throw new Error('verified applied catalog closure has no durable applied head');
    }
    const deployment = await resolveDeployment(
      trustedCatalogScope.networkId,
      new AbortController().signal,
    );
    const closure = await readVerifiedAppliedCatalogClosureV1({
      appliedHead,
      controlObjects: persistence.controlObjects,
      deployment,
      kaBundles: persistence.kaBundles,
      trustedCatalogScope,
      verifyIssuerSignature,
    });
    const currentAppliedHead = persistence.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      trustedCatalogScope.authorAddress,
    );
    if (!equalAppliedCatalogHeadSnapshotV1(appliedHead, currentAppliedHead)) {
      throw new Error('durable applied catalog head changed during verified closure read');
    }
    return closure;
  };
  proofReaders.set(owner, reader);
}

/** Bind the gate-only capability after the agent has started its catalog service. */
export function bindRfc64PrivateReleaseProofReaderV1(
  owner: object,
): Rfc64PrivateReleaseProofReaderV1 {
  const reader = proofReaders.get(owner);
  if (reader === undefined) {
    throw new TypeError('RFC-64 private release proof reader is unavailable');
  }
  return reader;
}

/** Revoke the gate-only capability as part of catalog-runtime teardown. */
export function unregisterRfc64PrivateReleaseProofReaderV1(owner: object): void {
  proofReaders.delete(owner);
}

function resolveSharedProofReaderRegistryV1(): WeakMap<
  object,
  Rfc64PrivateReleaseProofReaderV1
> {
  const existing = Reflect.get(globalThis, PROOF_READER_REGISTRY) as unknown;
  if (existing instanceof WeakMap) {
    return existing as WeakMap<object, Rfc64PrivateReleaseProofReaderV1>;
  }
  const created = new WeakMap<object, Rfc64PrivateReleaseProofReaderV1>();
  Object.defineProperty(globalThis, PROOF_READER_REGISTRY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  });
  return created;
}

function equalAppliedCatalogHeadSnapshotV1(
  expected: AppliedCatalogHeadSnapshotV1,
  current: AppliedCatalogHeadSnapshotV1 | null,
): boolean {
  return current !== null
    && current.catalogScopeDigest === expected.catalogScopeDigest
    && current.authorAddress === expected.authorAddress
    && current.currentCatalogHeadDigest === expected.currentCatalogHeadDigest
    && current.appliedInventoryDigest === expected.appliedInventoryDigest
    && current.catalogVersion === expected.catalogVersion
    && current.inventoryRowCount === expected.inventoryRowCount;
}
