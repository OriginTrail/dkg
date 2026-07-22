import {
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertNetworkIdV1,
  type BlockNumberV1,
  type ChainIdV1,
  type DecimalU256V1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { loadAbi } from './evm-adapter-abi.js';
import {
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import {
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from './current-finalized-evm-snapshot.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import {
  assertCanonicalNonzeroEvmAddress,
  isAbortSignal,
  snapshotExactDataRecord,
} from './strict-local-data.js';

const CONTEXT_GRAPH_STORAGE_INTERFACE = new ethers.Interface(loadAbi('ContextGraphStorage'));
const KNOWLEDGE_ASSET_STORAGE_INTERFACE = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));

const CONFIG_KEYS = Object.freeze([
  'chainId',
  'contextGraphStorageAddress',
  'knowledgeAssetStorageAddress',
  'networkId',
  'snapshot',
] as const);
const REQUEST_KEYS = Object.freeze(['contextGraphId', 'signal'] as const);
const UINT256_RETURN_BYTES = 32;
const UPDATE_CONTEXT_RETURN_BYTES = 7 * 32;
const PACKED_KA_NUMBER_BITS = 96n;
const PACKED_KA_NUMBER_MASK = (1n << PACKED_KA_NUMBER_BITS) - 1n;

/**
 * One count read plus one indexed-ID read and two assertion reads per row.
 * The exact grouping below consumes one count batch, ceil(N/4) ID batches,
 * and ceil(2N/4) assertion batches. 1,364 is the largest N that stays inside
 * both the pinned-snapshot batch and call budgets.
 */
export const FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 = Math.min(
  Math.floor((CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1 - 1) / 3),
  1_364,
);

export interface FinalizedVmChainScannerConfigV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
}

export interface FinalizedVmChainScanRequestV1 {
  readonly contextGraphId: DecimalU256V1;
  readonly signal: AbortSignal;
}

/** Chain-authenticated assertion identity before subgraph placement is joined. */
export interface FinalizedVmChainCandidateV1 {
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly ordinal: DecimalU64V1;
  readonly kaId: string;
  readonly ual: string;
  readonly authorAddress: EvmAddressV1;
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
  readonly finalizedBlockNumber: BlockNumberV1;
  readonly finalizedBlockHash: Digest32V1;
  readonly highestFinalizedOrdinal: DecimalU64V1 | null;
  readonly rows: readonly Readonly<FinalizedVmChainCandidateV1>[];
}

export interface FinalizedVmChainScannerV1 {
  (request: FinalizedVmChainScanRequestV1): Promise<Readonly<FinalizedVmChainInventoryV1>>;
}

interface ScannerConfigSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
}

/**
 * Build one bounded finalized-chain ordinal scanner.
 *
 * The scanner deliberately stops at chain-authenticated candidates. It does
 * not guess a subgraph or manufacture placementEvidenceDigest; the RFC-64
 * placement layer must join author-authorized catalog/placement evidence later.
 */
export function createFinalizedVmChainScannerV1(
  input: FinalizedVmChainScannerConfigV1,
): FinalizedVmChainScannerV1 {
  const config = snapshotConfig(input);
  const scan: FinalizedVmChainScannerV1 = async (inputRequest) => {
    const request = snapshotRequest(inputRequest);
    return config.snapshot({ chainId: config.chainId, signal: request.signal }, async (session) =>
      scanPinnedInventory(config, request.contextGraphId, session));
  };
  return Object.freeze(scan);
}

async function scanPinnedInventory(
  config: ScannerConfigSnapshotV1,
  contextGraphId: DecimalU256V1,
  session: StrictCurrentFinalizedEvmSnapshotSessionV1,
): Promise<Readonly<FinalizedVmChainInventoryV1>> {
  if (session.chainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Finalized VM snapshot returned chain ${session.chainId}, expected ${config.chainId}`,
    );
  }
  try {
    assertCanonicalDecimalU64(session.blockNumber, 'finalized VM snapshot block number');
    assertCanonicalDigest(session.blockHash, 'finalized VM snapshot block hash');
    if (typeof session.read !== 'function') throw new Error('snapshot read is not callable');
  } catch (cause) {
    throw malformedReturn('Finalized VM snapshot returned a malformed anchor capability', cause);
  }
  const contextGraphIdValue = BigInt(contextGraphId);
  const [encodedCount] = await session.read(Object.freeze([Object.freeze({
    to: config.contextGraphStorageAddress,
    data: CONTEXT_GRAPH_STORAGE_INTERFACE.encodeFunctionData(
      'getContextGraphKaCount',
      [contextGraphIdValue],
    ),
    maxReturnBytes: UINT256_RETURN_BYTES,
  })]));
  if (encodedCount === undefined) {
    throw malformedReturn('Finalized VM count read returned no result');
  }
  const rowCount = decodeUint256(
    CONTEXT_GRAPH_STORAGE_INTERFACE,
    'getContextGraphKaCount',
    encodedCount,
  );
  if (rowCount > BigInt(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'resource-limit',
      `Finalized VM inventory has ${rowCount} rows, above the v1 pinned-scan limit ${FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1}`,
    );
  }

  const rowCountNumber = Number(rowCount);
  const idCalls: StrictCurrentFinalizedEvmReadCallV1[] = [];
  for (let ordinal = 0; ordinal < rowCountNumber; ordinal += 1) {
    idCalls.push(Object.freeze({
      to: config.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_INTERFACE.encodeFunctionData(
        'getContextGraphKaAt',
        [contextGraphIdValue, BigInt(ordinal)],
      ),
      maxReturnBytes: UINT256_RETURN_BYTES,
    }));
  }
  const encodedIds = await readBatches(session, idCalls);
  const kaIds = encodedIds.map((encoded) => decodeUint256(
    CONTEXT_GRAPH_STORAGE_INTERFACE,
    'getContextGraphKaAt',
    encoded,
  ));

  const assertionCalls: StrictCurrentFinalizedEvmReadCallV1[] = [];
  for (const kaId of kaIds) {
    assertionCalls.push(
      Object.freeze({
        to: config.knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData(
          'getKnowledgeAssetUpdateContext',
          [kaId],
        ),
        maxReturnBytes: UPDATE_CONTEXT_RETURN_BYTES,
      }),
      Object.freeze({
        to: config.knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData(
          'getLatestMerkleRoot',
          [kaId],
        ),
        maxReturnBytes: UINT256_RETURN_BYTES,
      }),
    );
  }
  const encodedAssertions = await readBatches(session, assertionCalls);
  const rows = kaIds.map((kaId, ordinal) => {
    const encodedContext = encodedAssertions[ordinal * 2];
    const encodedRoot = encodedAssertions[(ordinal * 2) + 1];
    if (encodedContext === undefined || encodedRoot === undefined) {
      throw malformedReturn(`Finalized VM ordinal ${ordinal} is missing assertion results`);
    }
    const assertionVersion = decodeAssertionVersion(encodedContext);
    const assertionRoot = decodeBytes32(
      KNOWLEDGE_ASSET_STORAGE_INTERFACE,
      'getLatestMerkleRoot',
      encodedRoot,
    );
    const identity = unpackRootlessKaIdentity(kaId);
    return Object.freeze({
      chainId: config.chainId,
      contractAddress: config.contextGraphStorageAddress,
      ordinal: String(ordinal) as DecimalU64V1,
      kaId: kaId.toString(10),
      ual: `did:dkg:${config.networkId}/${identity.authorAddress}/${identity.kaNumber}`,
      authorAddress: identity.authorAddress,
      assertionVersion,
      assertionRoot,
      finalizedBlockNumber: session.blockNumber,
      finalizedBlockHash: session.blockHash,
    } satisfies FinalizedVmChainCandidateV1);
  });

  const highestFinalizedOrdinal = rowCount === 0n
    ? null
    : (rowCount - 1n).toString(10) as DecimalU64V1;
  return Object.freeze({
    networkId: config.networkId,
    contextGraphId,
    chainId: config.chainId,
    contractAddress: config.contextGraphStorageAddress,
    finalizedBlockNumber: session.blockNumber,
    finalizedBlockHash: session.blockHash,
    highestFinalizedOrdinal,
    rows: Object.freeze(rows),
  });
}

async function readBatches(
  session: StrictCurrentFinalizedEvmSnapshotSessionV1,
  calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
): Promise<readonly string[]> {
  const results: string[] = [];
  for (let offset = 0; offset < calls.length; offset += CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1) {
    const batch = Object.freeze(calls.slice(
      offset,
      offset + CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
    ));
    const batchResults = await session.read(batch);
    if (!Array.isArray(batchResults) || batchResults.length !== batch.length) {
      throw malformedReturn('Finalized VM batch result count differs from its request count');
    }
    results.push(...batchResults);
  }
  return Object.freeze(results);
}

function decodeAssertionVersion(encoded: string): DecimalU64V1 {
  const decoded = decodeCanonicalResult(
    KNOWLEDGE_ASSET_STORAGE_INTERFACE,
    'getKnowledgeAssetUpdateContext',
    encoded,
  );
  const version = BigInt(decoded[0] as bigint).toString(10);
  try {
    assertCanonicalDecimalU64(version, 'finalized VM assertion version');
  } catch (cause) {
    throw malformedReturn('Finalized VM assertion version is outside the canonical u64 domain', cause);
  }
  if (version === '0') {
    throw malformedReturn('Finalized VM assertion version must be positive');
  }
  return version;
}

function decodeUint256(
  abi: ethers.Interface,
  functionName: 'getContextGraphKaCount' | 'getContextGraphKaAt',
  encoded: string,
): bigint {
  const decoded = decodeCanonicalResult(abi, functionName, encoded);
  return BigInt(decoded[0] as bigint);
}

function decodeBytes32(
  abi: ethers.Interface,
  functionName: 'getLatestMerkleRoot',
  encoded: string,
): Digest32V1 {
  const decoded = decodeCanonicalResult(abi, functionName, encoded);
  const value = String(decoded[0]).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value) || value === `0x${'00'.repeat(32)}`) {
    throw malformedReturn('Finalized VM assertion root must be a nonzero bytes32 value');
  }
  return value as Digest32V1;
}

function decodeCanonicalResult(
  abi: ethers.Interface,
  functionName: string,
  encoded: string,
): ethers.Result {
  try {
    const decoded = abi.decodeFunctionResult(functionName, encoded);
    const canonical = abi.encodeFunctionResult(functionName, [...decoded]).toLowerCase();
    if (canonical !== encoded) {
      throw new Error(`${functionName} returned a non-canonical ABI encoding`);
    }
    return decoded;
  } catch (cause) {
    if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
    throw malformedReturn(`Finalized VM ${functionName} result is malformed`, cause);
  }
}

function unpackRootlessKaIdentity(kaId: bigint): Readonly<{
  authorAddress: EvmAddressV1;
  kaNumber: string;
}> {
  const authorValue = kaId >> PACKED_KA_NUMBER_BITS;
  if (authorValue === 0n || authorValue >= (1n << 160n)) {
    throw malformedReturn('Finalized VM row does not use the rootless packed KA identity');
  }
  const authorAddress = `0x${authorValue.toString(16).padStart(40, '0')}` as EvmAddressV1;
  const kaNumber = (kaId & PACKED_KA_NUMBER_MASK).toString(10);
  return Object.freeze({ authorAddress, kaNumber });
}

function snapshotConfig(input: unknown): ScannerConfigSnapshotV1 {
  try {
    const record = snapshotExactDataRecord(input, CONFIG_KEYS);
    assertNetworkIdV1(record.networkId, 'finalized VM scanner networkId');
    assertCanonicalChainId(record.chainId, 'finalized VM scanner chainId');
    assertCanonicalNonzeroEvmAddress(
      record.contextGraphStorageAddress,
      'finalized VM scanner ContextGraphStorage address',
    );
    assertCanonicalNonzeroEvmAddress(
      record.knowledgeAssetStorageAddress,
      'finalized VM scanner DKGKnowledgeAssets address',
    );
    if (typeof record.snapshot !== 'function') throw new Error('snapshot is not callable');
    const snapshot = record.snapshot as StrictCurrentFinalizedEvmSnapshotScopeV1;
    return Object.freeze({
      networkId: record.networkId,
      chainId: record.chainId,
      contextGraphStorageAddress: record.contextGraphStorageAddress,
      knowledgeAssetStorageAddress: record.knowledgeAssetStorageAddress,
      snapshot,
    });
  } catch (cause) {
    throw new TypeError('Finalized VM scanner configuration is invalid', { cause });
  }
}

function snapshotRequest(input: unknown): Readonly<FinalizedVmChainScanRequestV1> {
  try {
    const record = snapshotExactDataRecord(input, REQUEST_KEYS);
    assertCanonicalDecimalU256(record.contextGraphId, 'finalized VM contextGraphId');
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');
    return Object.freeze({ contextGraphId: record.contextGraphId, signal: record.signal });
  } catch (cause) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'Finalized VM scan request failed the fixed local profile',
      { cause },
    );
  }
}

function malformedReturn(
  message: string,
  cause?: unknown,
): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1(
    'malformed-return',
    message,
    cause === undefined ? {} : { cause },
  );
}

// Keep the derived public bound tied to the two snapshot budgets if either is
// tightened later; this assertion is module-load local and performs no I/O.
if (
  1 + Math.ceil(FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 / CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1)
    + Math.ceil((FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 * 2) / CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1)
  > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1
) {
  throw new Error('Finalized VM scan row bound exceeds the pinned-snapshot batch budget');
}
