import {
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalKaId,
  assertNetworkIdV1,
  unpackDeterministicRootlessKnowledgeAssetId,
  type BlockNumberV1,
  type ChainIdV1,
  type DecimalU256V1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  assertCanonicalNonzeroEvmAddress,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
} from './strict-local-data.js';

const INVENTORY_KEYS = Object.freeze([
  'chainId',
  'contextGraphId',
  'contractAddress',
  'finalizedBlockHash',
  'finalizedBlockNumber',
  'highestFinalizedOrdinal',
  'knowledgeAssetStorageAddress',
  'networkId',
  'rows',
] as const);
const CANDIDATE_KEYS = Object.freeze([
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
] as const);
/** Chain-authenticated assertion identity before subgraph placement is joined. */
export interface FinalizedVmChainCandidateV1 {
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly ordinal: DecimalU64V1;
  readonly kaId: string;
  readonly ual: string;
  readonly authorAddress: EvmAddressV1;
  readonly attestedAuthorAddress: EvmAddressV1 | null;
  readonly publisherAddress: EvmAddressV1 | null;
  readonly assertionVersion: DecimalU64V1;
  readonly assertionRoot: Digest32V1;
  readonly finalizedBlockNumber: BlockNumberV1;
  readonly finalizedBlockHash: Digest32V1;
}

export interface FinalizedVmChainInventoryV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: DecimalU256V1;
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly finalizedBlockNumber: BlockNumberV1;
  readonly finalizedBlockHash: Digest32V1;
  readonly highestFinalizedOrdinal: DecimalU64V1 | null;
  readonly rows: readonly Readonly<FinalizedVmChainCandidateV1>[];
}

export interface FinalizedVmChainInventorySnapshotOptionsV1 {
  /** Optional caller-owned resource ceiling; not part of the inventory model. */
  readonly maxRows?: number;
}

export class FinalizedVmChainInventoryValidationErrorV1 extends TypeError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'FinalizedVmChainInventoryValidationErrorV1';
  }
}

interface FinalizedVmChainInventoryHeaderSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: DecimalU256V1;
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly finalizedBlockNumber: BlockNumberV1;
  readonly finalizedBlockHash: Digest32V1;
  readonly highestFinalizedOrdinal: DecimalU64V1 | null;
}

/** Canonical chain-owned boundary for scanner output consumed across packages. */
export function snapshotFinalizedVmChainInventoryV1(
  input: unknown,
  options: FinalizedVmChainInventorySnapshotOptionsV1 = {},
): Readonly<FinalizedVmChainInventoryV1> {
  try {
    if (
      options.maxRows !== undefined
      && (
        !Number.isSafeInteger(options.maxRows)
        || options.maxRows < 0
      )
    ) {
      throw new Error('maxRows must be a nonnegative safe integer');
    }
    const record = snapshotExactDataRecord(input, INVENTORY_KEYS);
    assertNetworkIdV1(record.networkId, 'finalized VM inventory networkId');
    assertCanonicalDecimalU256(record.contextGraphId, 'finalized VM inventory contextGraphId');
    if (record.contextGraphId === '0') throw new Error('contextGraphId must be nonzero');
    assertCanonicalChainId(record.chainId, 'finalized VM inventory chainId');
    assertCanonicalNonzeroEvmAddress(record.contractAddress, 'finalized VM inventory contract');
    assertCanonicalNonzeroEvmAddress(
      record.knowledgeAssetStorageAddress,
      'finalized VM inventory KA storage',
    );
    assertCanonicalDecimalU64(
      record.finalizedBlockNumber,
      'finalized VM inventory block number',
    );
    assertCanonicalDigest(record.finalizedBlockHash, 'finalized VM inventory block hash');
    const highestFinalizedOrdinal = record.highestFinalizedOrdinal;
    if (highestFinalizedOrdinal !== null) {
      assertCanonicalDecimalU64(
        highestFinalizedOrdinal,
        'finalized VM inventory highest ordinal',
      );
    }
    const header = Object.freeze({
      networkId: record.networkId,
      contextGraphId: record.contextGraphId,
      chainId: record.chainId,
      contractAddress: record.contractAddress,
      knowledgeAssetStorageAddress: record.knowledgeAssetStorageAddress,
      finalizedBlockNumber: record.finalizedBlockNumber,
      finalizedBlockHash: record.finalizedBlockHash,
      highestFinalizedOrdinal,
    } satisfies FinalizedVmChainInventoryHeaderSnapshotV1);
    const untrustedRows = snapshotDenseDataArray(record.rows, {
      label: 'finalized VM inventory rows',
      ...(options.maxRows === undefined ? {} : { maxLength: options.maxRows }),
    });
    const rows = Object.freeze(untrustedRows.map((row, index) =>
      snapshotInventoryCandidate(row, index, header)));
    const expectedHighest = rows.length === 0 ? null : String(rows.length - 1);
    if (header.highestFinalizedOrdinal !== expectedHighest) {
      throw new Error('highest ordinal does not match the dense inventory rows');
    }
    return Object.freeze({ ...header, rows } satisfies FinalizedVmChainInventoryV1);
  } catch (cause) {
    if (cause instanceof FinalizedVmChainInventoryValidationErrorV1) throw cause;
    throw new FinalizedVmChainInventoryValidationErrorV1(
      'Finalized VM chain inventory is not canonical',
      { cause },
    );
  }
}

function snapshotInventoryCandidate(
  input: unknown,
  index: number,
  inventory: Readonly<FinalizedVmChainInventoryHeaderSnapshotV1>,
): Readonly<FinalizedVmChainCandidateV1> {
  const record = snapshotExactDataRecord(input, CANDIDATE_KEYS);
  assertCanonicalChainId(record.chainId, `finalized VM candidate ${index} chainId`);
  assertCanonicalNonzeroEvmAddress(record.contractAddress, `finalized VM candidate ${index} contract`);
  assertCanonicalNonzeroEvmAddress(
    record.knowledgeAssetStorageAddress,
    `finalized VM candidate ${index} KA storage`,
  );
  assertCanonicalDecimalU64(record.ordinal, `finalized VM candidate ${index} ordinal`);
  assertCanonicalKaId(record.kaId, `finalized VM candidate ${index} kaId`);
  assertCanonicalNonzeroEvmAddress(record.authorAddress, `finalized VM candidate ${index} author`);
  assertNullableInventoryAddress(
    record.attestedAuthorAddress,
    `finalized VM candidate ${index} attested author`,
  );
  assertNullableInventoryAddress(
    record.publisherAddress,
    `finalized VM candidate ${index} publisher`,
  );
  assertCanonicalDecimalU64(
    record.assertionVersion,
    `finalized VM candidate ${index} assertion version`,
  );
  assertCanonicalDigest(record.assertionRoot, `finalized VM candidate ${index} assertion root`);
  assertCanonicalDecimalU64(
    record.finalizedBlockNumber,
    `finalized VM candidate ${index} block number`,
  );
  assertCanonicalDigest(record.finalizedBlockHash, `finalized VM candidate ${index} block hash`);
  const identity = unpackDeterministicRootlessKnowledgeAssetId(
    inventory.networkId,
    BigInt(record.kaId),
  );
  if (
    record.ual !== identity.ual
    || record.authorAddress !== identity.agentAddress
    || record.assertionVersion === '0'
    || record.assertionRoot === ethers.ZeroHash
    || record.ordinal !== String(index)
    || record.chainId !== inventory.chainId
    || record.contractAddress !== inventory.contractAddress
    || record.knowledgeAssetStorageAddress !== inventory.knowledgeAssetStorageAddress
    || record.finalizedBlockNumber !== inventory.finalizedBlockNumber
    || record.finalizedBlockHash !== inventory.finalizedBlockHash
  ) {
    throw new Error(`finalized VM candidate ${index} differs from its identity or inventory lane`);
  }
  return Object.freeze({
    chainId: record.chainId,
    contractAddress: record.contractAddress,
    knowledgeAssetStorageAddress: record.knowledgeAssetStorageAddress,
    ordinal: record.ordinal,
    kaId: record.kaId,
    ual: record.ual,
    authorAddress: record.authorAddress,
    attestedAuthorAddress: record.attestedAuthorAddress,
    publisherAddress: record.publisherAddress,
    assertionVersion: record.assertionVersion,
    assertionRoot: record.assertionRoot,
    finalizedBlockNumber: record.finalizedBlockNumber,
    finalizedBlockHash: record.finalizedBlockHash,
  } satisfies FinalizedVmChainCandidateV1);
}

function assertNullableInventoryAddress(
  value: unknown,
  label: string,
): asserts value is EvmAddressV1 | null {
  if (value !== null) assertCanonicalNonzeroEvmAddress(value, label);
}
