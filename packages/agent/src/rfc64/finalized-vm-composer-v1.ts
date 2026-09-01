import {
  FinalizedVmSetAccumulatorV1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSubGraphNameV1,
  readVerifiedCatalogSealBindingV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type FinalizedVmSetEvidenceV1,
  type FinalizedVmSetRowV1,
  type SubGraphNameV1,
  type VerifiedCatalogSealBindingV1,
} from '@origintrail-official/dkg-core';
import {
  snapshotFinalizedContextGraphReadV1,
  snapshotFinalizedVmChainInventoryV1,
  type FinalizedContextGraphReadV1,
  type FinalizedVmChainCandidateV1,
  type FinalizedVmChainInventoryV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  type VerifiedAuthorCatalogRowAuthorshipV1,
} from './catalog-row-authorship.js';
import { assertRecoverableAuthorAttestationCapabilityV1 } from './recoverable-author-attestation-v1.js';

const COMPOSITION_KEYS = [
  'assertedAtKav10Address',
  'catalogAuthorAddress',
  'catalogLane',
  'finalizedContextGraph',
  'inventory',
  'placements',
] as const;
const LEGACY_COMPOSITION_KEYS = ['requireCompleteAuthorSet'] as const;
const CATALOG_LANE_KEYS = ['contextGraphId', 'subGraphName'] as const;
const PLACEMENT_KEYS = ['authorship', 'sealBinding'] as const;

export interface FinalizedVmCatalogLaneV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
}

/** Two process-local capabilities proving one author-authorized placed catalog row. */
export interface FinalizedVmPlacementEvidenceV1 {
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipV1;
  readonly sealBinding: VerifiedCatalogSealBindingV1;
}

export interface ComposeFinalizedVmSetRequestV1 {
  /** Trusted lifecycle/KAV10 deployment address against which catalog seals were authored. */
  readonly assertedAtKav10Address: EvmAddressV1;
  /** Exact author lane whose finalized chain rows must all be present. */
  readonly catalogAuthorAddress: EvmAddressV1;
  readonly catalogLane: FinalizedVmCatalogLaneV1;
  readonly finalizedContextGraph: FinalizedContextGraphReadV1;
  readonly inventory: FinalizedVmChainInventoryV1;
  readonly placements: readonly FinalizedVmPlacementEvidenceV1[];
  /**
   * @deprecated Completeness is derived from finalized access policy. Retained
   * only so pre-10.0.15 callers remain source/runtime compatible; `false`
   * cannot weaken private author-set completeness.
   */
  readonly requireCompleteAuthorSet?: boolean;
}

interface ResolvedFinalizedVmPlacementV1 {
  readonly authorship: ReturnType<typeof readVerifiedAuthorCatalogRowAuthorshipV1>;
  readonly sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>;
  readonly placement: Readonly<FinalizedVmPlacementEvidenceV1>;
}

export interface FinalizedVmMaterializationPlanRowV1 {
  readonly candidate: Readonly<FinalizedVmChainCandidateV1>;
  readonly placement: Readonly<FinalizedVmPlacementEvidenceV1>;
  readonly row: Readonly<FinalizedVmSetRowV1>;
}

export interface ComposedFinalizedVmSetV1 {
  readonly catalogLane: Readonly<FinalizedVmCatalogLaneV1>;
  readonly evidence: Readonly<FinalizedVmSetEvidenceV1>;
  readonly rows: readonly Readonly<FinalizedVmSetRowV1>[];
  /** Exact placement/inventory join in authoritative finalized ordinal order. */
  readonly materializations: readonly Readonly<FinalizedVmMaterializationPlanRowV1>[];
}

export type FinalizedVmCompositionErrorCodeV1 =
  | 'finalized-vm-composition-input'
  | 'finalized-vm-composition-inventory'
  | 'finalized-vm-composition-placement'
  | 'finalized-vm-composition-incomplete'
  | 'finalized-vm-composition-mismatch'
  | 'finalized-vm-composition-duplicate';

export class FinalizedVmCompositionErrorV1 extends Error {
  constructor(
    readonly code: FinalizedVmCompositionErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'FinalizedVmCompositionErrorV1';
  }
}

/**
 * Join author-authorized catalog placement to a same-anchor finalized chain inventory.
 *
 * Placement rows may be a strict subset of the CG-wide on-chain inventory because
 * one catalog lane can be the root or one named subgraph. They may also be a
 * strict superset: RFC-64 catalogs are tier-neutral, so an author-authorized row
 * absent from finalized chain inventory remains SWM-only. Output contains only
 * the placement/inventory intersection in authoritative on-chain ordinal order.
 */
export function composeFinalizedVmSetV1(
  untrustedRequest: ComposeFinalizedVmSetRequestV1,
): Readonly<ComposedFinalizedVmSetV1> {
  const request = snapshotRecord(
    untrustedRequest,
    COMPOSITION_KEYS,
    'finalized VM composition request',
    'finalized-vm-composition-input',
    LEGACY_COMPOSITION_KEYS,
  );
  const catalogLane = snapshotCatalogLane(request.catalogLane);
  let assertedAtKav10Address: EvmAddressV1;
  let catalogAuthorAddress: EvmAddressV1;
  let inventory: Readonly<FinalizedVmChainInventoryV1>;
  let finalizedContextGraph: Readonly<FinalizedContextGraphReadV1>;
  try {
    assertCanonicalEvmAddress(
      request.assertedAtKav10Address,
      'finalized VM assertedAtKav10Address',
    );
    assertedAtKav10Address = request.assertedAtKav10Address;
    assertCanonicalEvmAddress(
      request.catalogAuthorAddress,
      'finalized VM catalogAuthorAddress',
    );
    catalogAuthorAddress = request.catalogAuthorAddress;
    inventory = snapshotFinalizedVmChainInventoryV1(request.inventory);
    finalizedContextGraph = snapshotFinalizedContextGraphReadV1(
      request.finalizedContextGraph,
    );
  } catch (cause) {
    fail(
      'finalized-vm-composition-inventory',
      'chain inventory or finalized Context Graph binding is not canonical',
      cause,
    );
  }
  assertCatalogLaneMatchesFinalizedContextGraph(
    catalogLane,
    finalizedContextGraph,
    inventory,
  );
  let placements: readonly unknown[];
  try {
    placements = snapshotDenseArray(
      request.placements,
      'finalized VM placements',
      MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
    );
  } catch (cause) {
    fail(
      'finalized-vm-composition-placement',
      'finalized VM placements are not a bounded dense data-only array',
      cause,
    );
  }

  const placementsByKaId = new Map<string, Readonly<ResolvedFinalizedVmPlacementV1>>();
  for (const [index, untrustedPlacement] of placements.entries()) {
    const placement = snapshotPlacement(untrustedPlacement, index);
    let authorship: ReturnType<typeof readVerifiedAuthorCatalogRowAuthorshipV1>;
    let sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>;
    try {
      authorship = readVerifiedAuthorCatalogRowAuthorshipV1(placement.authorship);
      sealBinding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
      assertRecoverableAuthorAttestationCapabilityV1(sealBinding);
    } catch (cause) {
      fail(
        'finalized-vm-composition-placement',
        `placement ${index} was not minted by the catalog authority verifiers`,
        cause,
      );
    }
    if (
      authorship.contextGraphId !== catalogLane.contextGraphId
      || authorship.subGraphName !== catalogLane.subGraphName
      || authorship.authorAddress !== catalogAuthorAddress
      || authorship.governanceChainId !== finalizedContextGraph.chainId
      || authorship.governanceContractAddress !== finalizedContextGraph.governanceContract
    ) {
      fail(
        'finalized-vm-composition-mismatch',
        `placement ${index} belongs to a different catalog lane`,
      );
    }
    if (
      authorship.catalogScopeDigest !== sealBinding.catalogScopeDigest
      || authorship.catalogRowDigest !== sealBinding.catalogRowDigest
      || authorship.networkId !== sealBinding.networkId
      || authorship.authorAddress !== sealBinding.authorAddress
      || authorship.row.kaId !== sealBinding.kaId
      || authorship.row.assertionVersion !== sealBinding.assertionVersion
    ) {
      fail(
        'finalized-vm-composition-mismatch',
        `placement ${index} authorship and seal capabilities do not close over one row`,
      );
    }
    if (placementsByKaId.has(sealBinding.kaId)) {
      fail(
        'finalized-vm-composition-duplicate',
        `catalog lane contains duplicate placement evidence for KA ${sealBinding.kaId}`,
      );
    }
    placementsByKaId.set(sealBinding.kaId, Object.freeze({
      authorship,
      sealBinding,
      placement: Object.freeze(placement),
    }));
  }

  const scope = Object.freeze({
    networkId: inventory.networkId,
    chainId: inventory.chainId,
    contractAddress: inventory.contractAddress,
  });
  const accumulator = new FinalizedVmSetAccumulatorV1(scope);
  const materializations: Readonly<FinalizedVmMaterializationPlanRowV1>[] = [];
  for (const candidate of inventory.rows) {
    const placement = placementsByKaId.get(candidate.kaId);
    if (placement === undefined) {
      // Completeness is a property of the finalized policy, never a caller
      // option that could weaken a private author lane's closure requirement.
      if (
        finalizedContextGraph.accessPolicy === 1
        && candidate.authorAddress === catalogAuthorAddress
      ) {
        fail(
          'finalized-vm-composition-incomplete',
          `known-incomplete: no-authorized-provider for finalized KA ${candidate.kaId}`,
        );
      }
      continue;
    }
    const match = classifyCandidatePlacement(
      candidate,
      inventory,
      assertedAtKav10Address,
      placement.authorship,
      placement.sealBinding,
    );
    if (match === 'newer-swm-only') {
      // One catalog bucket has one row per KA, while the chain can still
      // finalize an older assertion version. A newer author-sealed catalog
      // row is therefore SWM-only evidence, not placement evidence for the
      // older finalized version. Leave the existing VM untouched; the chain
      // inventory remains its authoritative catalog and recovery source.
      continue;
    }
    placementsByKaId.delete(candidate.kaId);

    const row = Object.freeze({
      chainId: candidate.chainId,
      contractAddress: candidate.contractAddress,
      ordinal: candidate.ordinal,
      ual: candidate.ual,
      authorAddress: candidate.authorAddress,
      assertionVersion: candidate.assertionVersion,
      assertionRoot: candidate.assertionRoot,
      finalizedBlockNumber: candidate.finalizedBlockNumber,
      finalizedBlockHash: candidate.finalizedBlockHash,
      // The row digest commits catalogScopeDigest, whose exact scope includes
      // contextGraphId, subGraphName, and authorAddress, plus the selected row.
      placementEvidenceDigest: placement.authorship.catalogRowDigest,
    } satisfies FinalizedVmSetRowV1);
    accumulator.append(row);
    materializations.push(Object.freeze({
      candidate,
      placement: placement.placement,
      row,
    }));
  }
  // Remaining placements are valid, author-authorized SWM-only rows. They do
  // not participate in VM materialization until the same KA is present in a
  // future finalized chain snapshot. Private completeness still fails above
  // when any finalized asset authored in this lane is absent from the catalog.

  const frozenMaterializations = Object.freeze(materializations);
  return Object.freeze({
    catalogLane,
    evidence: accumulator.finalize(),
    // Backward-compatible evidence view derived from the canonical ordered plan.
    rows: Object.freeze(frozenMaterializations.map(({ row }) => row)),
    materializations: frozenMaterializations,
  });
}

function classifyCandidatePlacement(
  candidate: Readonly<FinalizedVmChainCandidateV1>,
  inventory: Readonly<FinalizedVmChainInventoryV1>,
  assertedAtKav10Address: EvmAddressV1,
  authorship: ReturnType<typeof readVerifiedAuthorCatalogRowAuthorshipV1>,
  sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>,
): 'exact-finalized-placement' | 'newer-swm-only' {
  const seal = sealBinding.seal;
  if (
    candidate.chainId !== seal.assertedAtChainId
    || assertedAtKav10Address !== seal.assertedAtKav10Address
    || candidate.kaId !== sealBinding.kaId
    || candidate.ual !== seal.kaUal
    || candidate.authorAddress !== sealBinding.authorAddress
    || candidate.attestedAuthorAddress === null
    || candidate.attestedAuthorAddress !== seal.authorAddress
    || candidate.publisherAddress === null
    || authorship.networkId !== inventory.networkId
  ) {
    fail(
      'finalized-vm-composition-mismatch',
      `catalog placement for KA ${candidate.kaId} differs from finalized chain truth`,
    );
  }
  const candidateVersion = BigInt(candidate.assertionVersion);
  const placementVersion = BigInt(seal.assertionVersion);
  if (placementVersion > candidateVersion) return 'newer-swm-only';
  if (
    placementVersion !== candidateVersion
    || candidate.assertionRoot !== seal.assertionMerkleRoot
  ) {
    fail(
      'finalized-vm-composition-mismatch',
      `catalog placement for KA ${candidate.kaId} differs from finalized chain truth`,
    );
  }
  return 'exact-finalized-placement';
}

function snapshotCatalogLane(input: unknown): Readonly<FinalizedVmCatalogLaneV1> {
  const record = snapshotRecord(
    input,
    CATALOG_LANE_KEYS,
    'finalized VM catalog lane',
    'finalized-vm-composition-input',
  );
  try {
    assertContextGraphIdV1(record.contextGraphId, 'catalogLane.contextGraphId');
    if (record.subGraphName !== null) {
      assertSubGraphNameV1(record.subGraphName, 'catalogLane.subGraphName');
    }
  } catch (cause) {
    fail('finalized-vm-composition-input', 'catalog lane is not canonical', cause);
  }
  return Object.freeze({
    contextGraphId: record.contextGraphId,
    subGraphName: record.subGraphName,
  }) as Readonly<FinalizedVmCatalogLaneV1>;
}

function assertCatalogLaneMatchesFinalizedContextGraph(
  catalogLane: Readonly<FinalizedVmCatalogLaneV1>,
  contextGraph: Readonly<FinalizedContextGraphReadV1>,
  inventory: Readonly<FinalizedVmChainInventoryV1>,
): void {
  const expectedNameHash = ethers.keccak256(
    ethers.toUtf8Bytes(catalogLane.contextGraphId),
  ).toLowerCase();
  if (
    !contextGraph.active
    || contextGraph.nameHash !== expectedNameHash
    || contextGraph.chainId !== inventory.chainId
    || contextGraph.contextGraphId !== inventory.contextGraphId
    || contextGraph.governanceContract !== inventory.contractAddress
    || contextGraph.blockNumber !== inventory.finalizedBlockNumber
    || contextGraph.blockHash !== inventory.finalizedBlockHash
  ) {
    fail(
      'finalized-vm-composition-mismatch',
      'catalog lane is not bound to this same-anchor finalized Context Graph inventory',
    );
  }
}

function snapshotPlacement(input: unknown, index: number): FinalizedVmPlacementEvidenceV1 {
  const record = snapshotRecord(
    input,
    PLACEMENT_KEYS,
    `finalized VM placement ${index}`,
    'finalized-vm-composition-placement',
  );
  return Object.freeze({
    authorship: record.authorship as VerifiedAuthorCatalogRowAuthorshipV1,
    sealBinding: record.sealBinding as VerifiedCatalogSealBindingV1,
  });
}

function snapshotDenseArray(
  input: unknown,
  label: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be an ordinary array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new Error(`${label} length is invalid`);
  }
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== length + 1) throw new Error(`${label} must be dense and data-only`);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${label} entries must be enumerable data properties`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotRecord<Code extends FinalizedVmCompositionErrorCodeV1>(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: Code,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('not a record');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('not plain');
    const actualKeys = Reflect.ownKeys(input);
    const accepted = new Set([...expectedKeys, ...optionalKeys]);
    if (
      actualKeys.length < expectedKeys.length
      || actualKeys.length > accepted.size
      || expectedKeys.some((key) => !actualKeys.includes(key))
      || actualKeys.some((key) => typeof key !== 'string' || !accepted.has(key))
    ) {
      throw new Error('unknown or missing fields');
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of actualKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        throw new Error('fields must be enumerable data properties');
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (cause) {
    fail(code, `${label} is not a closed data-only record`, cause);
  }
}

function fail(
  code: FinalizedVmCompositionErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new FinalizedVmCompositionErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
