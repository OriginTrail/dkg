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
  snapshotDenseDataArray,
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
const SESSION_CONFIG_KEYS = Object.freeze([
  'chainId',
  'contextGraphStorageAddress',
  'knowledgeAssetStorageAddress',
  'networkId',
] as const);
const REQUEST_KEYS = Object.freeze(['contextGraphId', 'signal'] as const);
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
const UINT256_RETURN_BYTES = 32;
const UPDATE_CONTEXT_RETURN_BYTES = 7 * 32;
const FIXED_SCAN_CALLS = 2;
const ID_CALLS_PER_ROW = 1;
const ASSERTION_CALLS_PER_ROW = 4;
const TOTAL_CALLS_PER_ROW = ID_CALLS_PER_ROW + ASSERTION_CALLS_PER_ROW;

/**
 * One active/count header plus one indexed-ID read and four assertion reads
 * per row. The exported ceiling is derived from the exact call and batching
 * equations so transport-budget changes cannot silently invalidate it.
 */
export const FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 = deriveFinalizedVmScanMaxRows(
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
);

export interface FinalizedVmChainSessionScannerConfigV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
}

export interface FinalizedVmChainScannerConfigV1
  extends FinalizedVmChainSessionScannerConfigV1 {
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
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
  readonly ordinal: DecimalU64V1;
  readonly kaId: string;
  readonly ual: string;
  readonly authorAddress: EvmAddressV1;
  /** Latest chain-verified author attestation; null is explicit legacy/incomplete state. */
  readonly attestedAuthorAddress: EvmAddressV1 | null;
  /** EOA that submitted the latest root; curated admission consumes this chain truth. */
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

export interface FinalizedVmChainScannerV1 {
  (request: FinalizedVmChainScanRequestV1): Promise<Readonly<FinalizedVmChainInventoryV1>>;
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
): Readonly<FinalizedVmChainInventoryV1> {
  try {
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
      maxLength: FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1,
    });
    const rows = Object.freeze(untrustedRows.map((row, index) =>
      snapshotInventoryCandidate(row, index, header)));
    const expectedHighest = rows.length === 0 ? null : String(rows.length - 1);
    if (header.highestFinalizedOrdinal !== expectedHighest) {
      throw new Error('highest ordinal does not match the dense inventory rows');
    }
    return Object.freeze({
      ...header,
      rows,
    } satisfies FinalizedVmChainInventoryV1);
  } catch (cause) {
    if (cause instanceof CurrentFinalizedEvmCallErrorV1) throw cause;
    throw malformedReturn('Finalized VM chain inventory is not canonical', cause);
  }
}

interface ScannerSessionConfigSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly knowledgeAssetStorageAddress: EvmAddressV1;
}

interface ScannerConfigSnapshotV1 extends ScannerSessionConfigSnapshotV1 {
  readonly snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
}

interface FinalizedVmAssertionReadV1 {
  readonly assertionVersion: DecimalU64V1;
  readonly assertionRoot: Digest32V1;
  readonly attestedAuthorAddress: EvmAddressV1 | null;
  readonly publisherAddress: EvmAddressV1 | null;
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

/**
 * Scan inside a caller-owned snapshot session. Runtime composition uses this
 * seam to read the CG policy/name binding and VM inventory at one exact anchor
 * instead of opening a second independently finalized view.
 */
export function scanFinalizedVmChainInventoryInSnapshotV1(
  input: FinalizedVmChainSessionScannerConfigV1,
  inputRequest: FinalizedVmChainScanRequestV1,
  session: StrictCurrentFinalizedEvmSnapshotSessionV1,
): Promise<Readonly<FinalizedVmChainInventoryV1>> {
  const config = snapshotSessionConfig(input);
  const request = snapshotRequest(inputRequest);
  return scanPinnedInventory(config, request.contextGraphId, session);
}

async function scanPinnedInventory(
  config: ScannerSessionConfigSnapshotV1,
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
  const encodedHeader = await session.read(Object.freeze([
    Object.freeze({
      to: config.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_INTERFACE.encodeFunctionData(
        'isContextGraphActive',
        [contextGraphIdValue],
      ),
      maxReturnBytes: UINT256_RETURN_BYTES,
    }),
    Object.freeze({
      to: config.contextGraphStorageAddress,
      data: CONTEXT_GRAPH_STORAGE_INTERFACE.encodeFunctionData(
        'getContextGraphKaCount',
        [contextGraphIdValue],
      ),
      maxReturnBytes: UINT256_RETURN_BYTES,
    }),
  ]));
  if (!Array.isArray(encodedHeader) || encodedHeader.length !== FIXED_SCAN_CALLS) {
    throw malformedReturn('Finalized VM context-graph header result count is invalid');
  }
  const [encodedActive, encodedCount] = encodedHeader;
  if (encodedActive === undefined || encodedCount === undefined) {
    throw malformedReturn('Finalized VM context-graph header read returned incomplete results');
  }
  if (!decodeBoolean(CONTEXT_GRAPH_STORAGE_INTERFACE, 'isContextGraphActive', encodedActive)) {
    throw malformedReturn(
      `Finalized VM context graph ${contextGraphId} is not active at the pinned anchor`,
    );
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

  const assertions = await readFinalizedVmAssertions(
    session,
    config.knowledgeAssetStorageAddress,
    kaIds,
  );
  const rows = kaIds.map((kaId, ordinal) => {
    const assertion = assertions[ordinal];
    if (assertion === undefined) {
      throw malformedReturn(`Finalized VM ordinal ${ordinal} is missing assertion results`);
    }
    let identity: ReturnType<typeof unpackDeterministicRootlessKnowledgeAssetId>;
    try {
      identity = unpackDeterministicRootlessKnowledgeAssetId(config.networkId, kaId);
    } catch (cause) {
      throw malformedReturn(
        `Finalized VM ordinal ${ordinal} does not use the canonical rootless KA identity`,
        cause,
      );
    }
    return Object.freeze({
      chainId: config.chainId,
      contractAddress: config.contextGraphStorageAddress,
      knowledgeAssetStorageAddress: config.knowledgeAssetStorageAddress,
      ordinal: String(ordinal) as DecimalU64V1,
      kaId: identity.kaId,
      ual: identity.ual,
      authorAddress: identity.agentAddress as EvmAddressV1,
      attestedAuthorAddress: assertion.attestedAuthorAddress,
      publisherAddress: assertion.publisherAddress,
      assertionVersion: assertion.assertionVersion,
      assertionRoot: assertion.assertionRoot,
      finalizedBlockNumber: session.blockNumber,
      finalizedBlockHash: session.blockHash,
    } satisfies FinalizedVmChainCandidateV1);
  });

  const highestFinalizedOrdinal = rowCount === 0n
    ? null
    : (rowCount - 1n).toString(10) as DecimalU64V1;
  return snapshotFinalizedVmChainInventoryV1({
    networkId: config.networkId,
    contextGraphId,
    chainId: config.chainId,
    contractAddress: config.contextGraphStorageAddress,
    knowledgeAssetStorageAddress: config.knowledgeAssetStorageAddress,
    finalizedBlockNumber: session.blockNumber,
    finalizedBlockHash: session.blockHash,
    highestFinalizedOrdinal,
    rows: Object.freeze(rows),
  });
}

function snapshotInventoryCandidate(
  input: unknown,
  index: number,
  inventory: Readonly<FinalizedVmChainInventoryHeaderSnapshotV1>,
): Readonly<FinalizedVmChainCandidateV1> {
  const record = snapshotExactDataRecord(input, CANDIDATE_KEYS);
  assertCanonicalChainId(record.chainId, `finalized VM candidate ${index} chainId`);
  assertCanonicalNonzeroEvmAddress(
    record.contractAddress,
    `finalized VM candidate ${index} contract`,
  );
  assertCanonicalNonzeroEvmAddress(
    record.knowledgeAssetStorageAddress,
    `finalized VM candidate ${index} KA storage`,
  );
  assertCanonicalDecimalU64(record.ordinal, `finalized VM candidate ${index} ordinal`);
  assertCanonicalKaId(record.kaId, `finalized VM candidate ${index} kaId`);
  assertCanonicalNonzeroEvmAddress(
    record.authorAddress,
    `finalized VM candidate ${index} author`,
  );
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
  assertCanonicalDigest(
    record.finalizedBlockHash,
    `finalized VM candidate ${index} block hash`,
  );
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

async function readFinalizedVmAssertions(
  session: StrictCurrentFinalizedEvmSnapshotSessionV1,
  knowledgeAssetStorageAddress: EvmAddressV1,
  kaIds: readonly bigint[],
): Promise<readonly Readonly<FinalizedVmAssertionReadV1>[]> {
  const rows: Readonly<FinalizedVmAssertionReadV1>[] = [];
  for (const [ordinal, kaId] of kaIds.entries()) {
    const calls = Object.freeze([
      Object.freeze({
        to: knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData(
          'getKnowledgeAssetUpdateContext',
          [kaId],
        ),
        maxReturnBytes: UPDATE_CONTEXT_RETURN_BYTES,
      }),
      Object.freeze({
        to: knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData('getLatestMerkleRoot', [kaId]),
        maxReturnBytes: UINT256_RETURN_BYTES,
      }),
      Object.freeze({
        to: knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData(
          'getLatestMerkleRootAuthor',
          [kaId],
        ),
        maxReturnBytes: UINT256_RETURN_BYTES,
      }),
      Object.freeze({
        to: knowledgeAssetStorageAddress,
        data: KNOWLEDGE_ASSET_STORAGE_INTERFACE.encodeFunctionData(
          'getLatestMerkleRootPublisher',
          [kaId],
        ),
        maxReturnBytes: UINT256_RETURN_BYTES,
      }),
    ] as const);
    const encoded = await session.read(calls);
    if (!Array.isArray(encoded) || encoded.length !== calls.length) {
      throw malformedReturn(`Finalized VM ordinal ${ordinal} assertion batch is incomplete`);
    }
    const [encodedContext, encodedRoot, encodedAuthor, encodedPublisher] = encoded;
    if (
      encodedContext === undefined
      || encodedRoot === undefined
      || encodedAuthor === undefined
      || encodedPublisher === undefined
    ) {
      throw malformedReturn(`Finalized VM ordinal ${ordinal} is missing assertion results`);
    }
    rows.push(Object.freeze({
      assertionVersion: decodeAssertionVersion(encodedContext),
      assertionRoot: decodeBytes32(
        KNOWLEDGE_ASSET_STORAGE_INTERFACE,
        'getLatestMerkleRoot',
        encodedRoot,
      ),
      attestedAuthorAddress: decodeNullableAddress(
        KNOWLEDGE_ASSET_STORAGE_INTERFACE,
        'getLatestMerkleRootAuthor',
        encodedAuthor,
      ),
      publisherAddress: decodeNullableAddress(
        KNOWLEDGE_ASSET_STORAGE_INTERFACE,
        'getLatestMerkleRootPublisher',
        encodedPublisher,
      ),
    } satisfies FinalizedVmAssertionReadV1));
  }
  return Object.freeze(rows);
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

function decodeBoolean(
  abi: ethers.Interface,
  functionName: 'isContextGraphActive',
  encoded: string,
): boolean {
  const decoded = decodeCanonicalResult(abi, functionName, encoded);
  if (typeof decoded[0] !== 'boolean') {
    throw malformedReturn(`Finalized VM ${functionName} result is not boolean`);
  }
  return decoded[0];
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

function decodeNullableAddress(
  abi: ethers.Interface,
  functionName: 'getLatestMerkleRootAuthor' | 'getLatestMerkleRootPublisher',
  encoded: string,
): EvmAddressV1 | null {
  const decoded = decodeCanonicalResult(abi, functionName, encoded);
  const value = String(decoded[0]).toLowerCase();
  if (value === ethers.ZeroAddress) return null;
  try {
    assertCanonicalNonzeroEvmAddress(value, `finalized VM ${functionName} address`);
  } catch (cause) {
    throw malformedReturn(`Finalized VM ${functionName} address is malformed`, cause);
  }
  return value;
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

function snapshotConfig(input: unknown): ScannerConfigSnapshotV1 {
  try {
    const record = snapshotExactDataRecord(input, CONFIG_KEYS);
    const sessionConfig = snapshotSessionConfigFields(record);
    if (typeof record.snapshot !== 'function') throw new Error('snapshot is not callable');
    const snapshot = record.snapshot as StrictCurrentFinalizedEvmSnapshotScopeV1;
    return Object.freeze({
      ...sessionConfig,
      snapshot,
    });
  } catch (cause) {
    throw new TypeError('Finalized VM scanner configuration is invalid', { cause });
  }
}

function snapshotSessionConfig(input: unknown): ScannerSessionConfigSnapshotV1 {
  try {
    const record = snapshotExactDataRecord(input, SESSION_CONFIG_KEYS);
    return snapshotSessionConfigFields(record);
  } catch (cause) {
    throw new TypeError('Finalized VM session scanner configuration is invalid', { cause });
  }
}

function snapshotSessionConfigFields(
  record: Record<string, unknown>,
): ScannerSessionConfigSnapshotV1 {
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
  return Object.freeze({
    networkId: record.networkId,
    chainId: record.chainId,
    contextGraphStorageAddress: record.contextGraphStorageAddress,
    knowledgeAssetStorageAddress: record.knowledgeAssetStorageAddress,
  });
}

function snapshotRequest(input: unknown): Readonly<FinalizedVmChainScanRequestV1> {
  try {
    const record = snapshotExactDataRecord(input, REQUEST_KEYS);
    assertCanonicalDecimalU256(record.contextGraphId, 'finalized VM contextGraphId');
    if (record.contextGraphId === '0') throw new Error('contextGraphId must be nonzero');
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

function deriveFinalizedVmScanMaxRows(
  maxCalls: number,
  maxBatches: number,
  maxCallsPerBatch: number,
): number {
  const fits = (rows: number): boolean => (
    FIXED_SCAN_CALLS + (rows * TOTAL_CALLS_PER_ROW) <= maxCalls
    && 1
      + Math.ceil((rows * ID_CALLS_PER_ROW) / maxCallsPerBatch)
      + Math.ceil((rows * ASSERTION_CALLS_PER_ROW) / maxCallsPerBatch)
      <= maxBatches
  );
  let lower = 0;
  let upper = Math.max(0, Math.floor((maxCalls - FIXED_SCAN_CALLS) / TOTAL_CALLS_PER_ROW));
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (fits(candidate)) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
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
  1
    + Math.ceil(
      (FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 * ID_CALLS_PER_ROW)
      / CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
    )
    + Math.ceil(
      (FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 * ASSERTION_CALLS_PER_ROW)
      / CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
    )
  > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1
  || FIXED_SCAN_CALLS + (FINALIZED_VM_CHAIN_SCAN_MAX_ROWS_V1 * TOTAL_CALLS_PER_ROW)
    > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1
) {
  throw new Error('Finalized VM scan row bound exceeds a pinned-snapshot resource budget');
}
