import {
  FinalizedVmSetAccumulatorV1,
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalKaId,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  readVerifiedCatalogSealBindingV1,
  unpackDeterministicRootlessKnowledgeAssetId,
  type ContextGraphIdV1,
  type FinalizedVmSetEvidenceV1,
  type FinalizedVmSetRowV1,
  type SubGraphNameV1,
  type VerifiedCatalogSealBindingV1,
} from '@origintrail-official/dkg-core';
/*
 * These are scanner outputs, not trusted casts. The composer revalidates the
 * complete structural inventory before consuming either capability set.
 */
import {
  FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
  type FinalizedVmChainCandidateV1,
  type FinalizedVmChainInventoryV1,
} from '@origintrail-official/dkg-chain';

import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  type VerifiedAuthorCatalogRowAuthorshipV1,
} from './catalog-row-authorship.js';

const COMPOSITION_KEYS = ['catalogLane', 'inventory', 'placements'] as const;
const CATALOG_LANE_KEYS = ['contextGraphId', 'subGraphName'] as const;
const PLACEMENT_KEYS = ['authorship', 'sealBinding'] as const;
const INVENTORY_KEYS = [
  'chainId',
  'contextGraphId',
  'contractAddress',
  'finalizedBlockHash',
  'finalizedBlockNumber',
  'highestFinalizedOrdinal',
  'knowledgeAssetStorageAddress',
  'networkId',
  'rows',
] as const;
const CANDIDATE_KEYS = [
  'assertionRoot',
  'assertionVersion',
  'attestedAuthorAddress',
  'authorAddress',
  'chainId',
  'contractAddress',
  'finalizedBlockHash',
  'finalizedBlockNumber',
  'kaId',
  'knowledgeAssetStorageAddress',
  'ordinal',
  'publisherAddress',
  'ual',
] as const;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

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
  readonly catalogLane: FinalizedVmCatalogLaneV1;
  readonly inventory: FinalizedVmChainInventoryV1;
  readonly placements: readonly FinalizedVmPlacementEvidenceV1[];
}

export interface ComposedFinalizedVmSetV1 {
  readonly catalogLane: Readonly<FinalizedVmCatalogLaneV1>;
  readonly evidence: Readonly<FinalizedVmSetEvidenceV1>;
  readonly rows: readonly Readonly<FinalizedVmSetRowV1>[];
}

export type FinalizedVmCompositionErrorCodeV1 =
  | 'finalized-vm-composition-input'
  | 'finalized-vm-composition-inventory'
  | 'finalized-vm-composition-placement'
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
 * one catalog lane can be the root or one named subgraph. Every supplied placement
 * must resolve exactly once; output retains the authoritative on-chain ordinal order.
 */
export function composeFinalizedVmSetV1(
  untrustedRequest: ComposeFinalizedVmSetRequestV1,
): Readonly<ComposedFinalizedVmSetV1> {
  const request = snapshotRecord(
    untrustedRequest,
    COMPOSITION_KEYS,
    'finalized VM composition request',
    'finalized-vm-composition-input',
  );
  const catalogLane = snapshotCatalogLane(request.catalogLane);
  const inventory = snapshotInventory(request.inventory);
  let placements: readonly unknown[];
  try {
    placements = snapshotDenseArray(
      request.placements,
      'finalized VM placements',
      inventory.rows.length,
    );
  } catch (cause) {
    fail(
      'finalized-vm-composition-placement',
      'finalized VM placements are not a bounded dense data-only array',
      cause,
    );
  }

  const placementsByKaId = new Map<string, Readonly<FinalizedVmPlacementEvidenceV1>>();
  for (const [index, untrustedPlacement] of placements.entries()) {
    const placement = snapshotPlacement(untrustedPlacement, index);
    let authorship: ReturnType<typeof readVerifiedAuthorCatalogRowAuthorshipV1>;
    let sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>;
    try {
      authorship = readVerifiedAuthorCatalogRowAuthorshipV1(placement.authorship);
      sealBinding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
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
    placementsByKaId.set(sealBinding.kaId, Object.freeze(placement));
  }

  const scope = Object.freeze({
    networkId: inventory.networkId,
    chainId: inventory.chainId,
    contractAddress: inventory.contractAddress,
  });
  const accumulator = new FinalizedVmSetAccumulatorV1(scope);
  const rows: Readonly<FinalizedVmSetRowV1>[] = [];
  for (const candidate of inventory.rows) {
    const placement = placementsByKaId.get(candidate.kaId);
    if (placement === undefined) continue;
    const authorship = readVerifiedAuthorCatalogRowAuthorshipV1(placement.authorship);
    const sealBinding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
    assertCandidateMatchesPlacement(candidate, inventory, authorship, sealBinding);
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
      placementEvidenceDigest: authorship.catalogRowDigest,
    } satisfies FinalizedVmSetRowV1);
    accumulator.append(row);
    rows.push(row);
  }
  if (placementsByKaId.size !== 0) {
    const [missingKaId] = placementsByKaId.keys();
    fail(
      'finalized-vm-composition-mismatch',
      `catalog placement KA ${missingKaId} is absent from the finalized chain inventory`,
    );
  }

  return Object.freeze({
    catalogLane,
    evidence: accumulator.finalize(),
    rows: Object.freeze(rows),
  });
}

function assertCandidateMatchesPlacement(
  candidate: Readonly<FinalizedVmChainCandidateV1>,
  inventory: Readonly<FinalizedVmChainInventoryV1>,
  authorship: ReturnType<typeof readVerifiedAuthorCatalogRowAuthorshipV1>,
  sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>,
): void {
  const seal = sealBinding.seal;
  if (
    candidate.chainId !== seal.assertedAtChainId
    || candidate.knowledgeAssetStorageAddress !== seal.assertedAtKav10Address
    || candidate.kaId !== sealBinding.kaId
    || candidate.ual !== seal.kaUal
    || candidate.authorAddress !== sealBinding.authorAddress
    || candidate.assertionVersion !== seal.assertionVersion
    || candidate.assertionRoot !== seal.assertionMerkleRoot
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

function snapshotInventory(input: unknown): Readonly<FinalizedVmChainInventoryV1> {
  const record = snapshotRecord(
    input,
    INVENTORY_KEYS,
    'finalized VM chain inventory',
    'finalized-vm-composition-inventory',
  );
  let rows: readonly Readonly<FinalizedVmChainCandidateV1>[];
  try {
    assertNetworkIdV1(record.networkId, 'inventory.networkId');
    assertCanonicalDecimalU256(record.contextGraphId, 'inventory.contextGraphId');
    assertCanonicalChainId(record.chainId, 'inventory.chainId');
    assertNonzeroAddress(record.contractAddress, 'inventory.contractAddress');
    assertNonzeroAddress(
      record.knowledgeAssetStorageAddress,
      'inventory.knowledgeAssetStorageAddress',
    );
    assertCanonicalDecimalU64(record.finalizedBlockNumber, 'inventory.finalizedBlockNumber');
    assertCanonicalDigest(record.finalizedBlockHash, 'inventory.finalizedBlockHash');
    if (record.highestFinalizedOrdinal !== null) {
      assertCanonicalDecimalU64(
        record.highestFinalizedOrdinal,
        'inventory.highestFinalizedOrdinal',
      );
    }
    const untrustedRows = snapshotDenseArray(
      record.rows,
      'finalized VM inventory rows',
      FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
    );
    rows = Object.freeze(untrustedRows.map((row, index) => snapshotCandidate(row, index, record)));
  } catch (cause) {
    if (cause instanceof FinalizedVmCompositionErrorV1) throw cause;
    fail('finalized-vm-composition-inventory', 'chain inventory is not canonical', cause);
  }

  const expectedHighest = rows.length === 0 ? null : String(rows.length - 1);
  if (record.highestFinalizedOrdinal !== expectedHighest) {
    fail(
      'finalized-vm-composition-inventory',
      'chain inventory highest ordinal does not match its dense indexed rows',
    );
  }
  return Object.freeze({
    networkId: record.networkId,
    contextGraphId: record.contextGraphId,
    chainId: record.chainId,
    contractAddress: record.contractAddress,
    knowledgeAssetStorageAddress: record.knowledgeAssetStorageAddress,
    finalizedBlockNumber: record.finalizedBlockNumber,
    finalizedBlockHash: record.finalizedBlockHash,
    highestFinalizedOrdinal: record.highestFinalizedOrdinal,
    rows,
  }) as Readonly<FinalizedVmChainInventoryV1>;
}

function snapshotCandidate(
  input: unknown,
  index: number,
  inventory: Record<string, unknown>,
): Readonly<FinalizedVmChainCandidateV1> {
  const record = snapshotRecord(
    input,
    CANDIDATE_KEYS,
    `finalized VM candidate ${index}`,
    'finalized-vm-composition-inventory',
  );
  try {
    assertCanonicalChainId(record.chainId, `candidate ${index} chainId`);
    assertNonzeroAddress(record.contractAddress, `candidate ${index} contractAddress`);
    assertNonzeroAddress(
      record.knowledgeAssetStorageAddress,
      `candidate ${index} knowledgeAssetStorageAddress`,
    );
    assertCanonicalDecimalU64(record.ordinal, `candidate ${index} ordinal`);
    assertCanonicalKaId(record.kaId, `candidate ${index} kaId`);
    assertNonzeroAddress(record.authorAddress, `candidate ${index} authorAddress`);
    assertNullableNonzeroAddress(
      record.attestedAuthorAddress,
      `candidate ${index} attestedAuthorAddress`,
    );
    assertNullableNonzeroAddress(record.publisherAddress, `candidate ${index} publisherAddress`);
    assertCanonicalDecimalU64(record.assertionVersion, `candidate ${index} assertionVersion`);
    assertCanonicalDigest(record.assertionRoot, `candidate ${index} assertionRoot`);
    assertCanonicalDecimalU64(
      record.finalizedBlockNumber,
      `candidate ${index} finalizedBlockNumber`,
    );
    assertCanonicalDigest(record.finalizedBlockHash, `candidate ${index} finalizedBlockHash`);
    const identity = unpackDeterministicRootlessKnowledgeAssetId(
      inventory.networkId as never,
      BigInt(record.kaId as string),
    );
    if (record.ual !== identity.ual || record.authorAddress !== identity.agentAddress) {
      throw new Error(`candidate ${index} identity differs from its packed KA id`);
    }
    if (record.assertionVersion === '0' || record.assertionRoot === `0x${'00'.repeat(32)}`) {
      throw new Error(`candidate ${index} assertion state must be nonzero`);
    }
  } catch (cause) {
    fail('finalized-vm-composition-inventory', `candidate ${index} is not canonical`, cause);
  }
  if (
    record.ordinal !== String(index)
    || record.chainId !== inventory.chainId
    || record.contractAddress !== inventory.contractAddress
    || record.knowledgeAssetStorageAddress !== inventory.knowledgeAssetStorageAddress
    || record.finalizedBlockNumber !== inventory.finalizedBlockNumber
    || record.finalizedBlockHash !== inventory.finalizedBlockHash
  ) {
    fail(
      'finalized-vm-composition-inventory',
      `candidate ${index} differs from the inventory lane or pinned anchor`,
    );
  }
  return Object.freeze({ ...record }) as unknown as Readonly<FinalizedVmChainCandidateV1>;
}

function snapshotPlacement(input: unknown, index: number): FinalizedVmPlacementEvidenceV1 {
  const record = snapshotRecord(
    input,
    PLACEMENT_KEYS,
    `finalized VM placement ${index}`,
    'finalized-vm-composition-placement',
  );
  return {
    authorship: record.authorship as VerifiedAuthorCatalogRowAuthorshipV1,
    sealBinding: record.sealBinding as VerifiedCatalogSealBindingV1,
  };
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
): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('not a record');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('not plain');
    const actualKeys = Reflect.ownKeys(input);
    const expected = new Set(expectedKeys);
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      throw new Error('unknown or missing fields');
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
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

function assertNullableNonzeroAddress(value: unknown, label: string): void {
  if (value === null) return;
  assertNonzeroAddress(value, label);
}

function assertNonzeroAddress(value: unknown, label: string): void {
  assertCanonicalEvmAddress(value, label);
  if (value === ZERO_ADDRESS) throw new Error(`${label} must be nonzero`);
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
