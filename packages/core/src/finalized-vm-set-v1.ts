import { sha256 } from '@noble/hashes/sha2.js';

import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { parseDeterministicKnowledgeAssetUal } from './ka-content-scope.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  MAX_DECIMAL_U64,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';

export const FINALIZED_VM_SET_LEAF_DIGEST_DOMAIN_V1 =
  'dkg-finalized-vm-set-leaf-v1\n' as const;
export const FINALIZED_VM_SET_NODE_DIGEST_DOMAIN_V1 =
  'dkg-finalized-vm-set-node-v1\n' as const;
export const FINALIZED_VM_SET_ODD_DIGEST_DOMAIN_V1 =
  'dkg-finalized-vm-set-odd-v1\n' as const;
export const FINALIZED_VM_SET_EMPTY_DIGEST_DOMAIN_V1 =
  'dkg-finalized-vm-set-empty-v1\n' as const;

const UTF8 = new TextEncoder();
const LEAF_DOMAIN_BYTES = UTF8.encode(FINALIZED_VM_SET_LEAF_DIGEST_DOMAIN_V1);
const NODE_DOMAIN_BYTES = UTF8.encode(FINALIZED_VM_SET_NODE_DIGEST_DOMAIN_V1);
const ODD_DOMAIN_BYTES = UTF8.encode(FINALIZED_VM_SET_ODD_DIGEST_DOMAIN_V1);
const EMPTY_DOMAIN_BYTES = UTF8.encode(FINALIZED_VM_SET_EMPTY_DIGEST_DOMAIN_V1);

const FINALIZED_VM_LANE_KEYS = ['chainId', 'contractAddress'] as const;
const FINALIZED_VM_SET_SCOPE_KEYS = ['networkId', 'chainId', 'contractAddress'] as const;
const FINALIZED_VM_SET_ROW_KEYS = [
  'assertionRoot',
  'assertionVersion',
  'authorAddress',
  'chainId',
  'contractAddress',
  'finalizedBlockHash',
  'finalizedBlockNumber',
  'ordinal',
  'placementEvidenceDigest',
  'ual',
] as const;

export interface FinalizedVmLaneV1 {
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
}

/** Subscription-pinned v10.0.8 network profile for one finalized VM set. */
export interface FinalizedVmSetScopeV1 extends FinalizedVmLaneV1 {
  readonly networkId: NetworkIdV1;
}

/**
 * Exact placed finalized-chain row committed by one RFC-64 subgraph VM lane.
 *
 * This is deliberately structural evidence only. Constructing or hashing one
 * of these rows does not establish finality, publisher authorization, author
 * authority, subgraph placement authority, or semantic activation.
 */
export interface FinalizedVmSetRowV1 extends FinalizedVmLaneV1 {
  readonly ordinal: DecimalU64V1;
  readonly ual: string;
  readonly authorAddress: EvmAddressV1;
  readonly assertionVersion: DecimalU64V1;
  readonly assertionRoot: Digest32V1;
  readonly finalizedBlockNumber: DecimalU64V1;
  readonly finalizedBlockHash: Digest32V1;
  readonly placementEvidenceDigest: Digest32V1;
}

export interface FinalizedVmSetEvidenceV1 {
  readonly scope: Readonly<FinalizedVmSetScopeV1>;
  readonly rootDigest: Digest32V1;
  readonly rowCount: DecimalU64V1;
  readonly highestFinalizedOrdinal: DecimalU64V1 | null;
}

type CanonicalFinalizedVmSetRowV1 = Readonly<FinalizedVmSetRowV1>
  & Readonly<Record<string, CanonicalJsonValue>>;

interface ValidatedFinalizedVmSetRowV1 {
  readonly row: CanonicalFinalizedVmSetRowV1;
  readonly ordinalValue: bigint;
}

export type FinalizedVmSetV1ErrorCode =
  | 'finalized-vm-set-schema'
  | 'finalized-vm-set-scalar'
  | 'finalized-vm-set-lane'
  | 'finalized-vm-set-order'
  | 'finalized-vm-set-ual'
  | 'finalized-vm-set-state';

export class FinalizedVmSetV1Error extends Error {
  constructor(
    readonly code: FinalizedVmSetV1ErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'FinalizedVmSetV1Error';
  }
}

/** Maximum v10.0.8 deterministic UAL bytes under the frozen network/id bounds. */
export const MAX_FINALIZED_VM_SET_UAL_BYTES_V1 = 209;

/** Snapshot and validate the exact chain/contract lane before any row callbacks run. */
export function snapshotFinalizedVmLaneV1(input: FinalizedVmLaneV1): Readonly<FinalizedVmLaneV1> {
  const record = snapshotRecord(input, FINALIZED_VM_LANE_KEYS, 'finalized VM lane');
  try {
    assertCanonicalChainId(record.chainId, 'lane.chainId');
    assertCanonicalEvmAddress(record.contractAddress, 'lane.contractAddress');
  } catch (cause) {
    fail('finalized-vm-set-scalar', 'finalized VM lane contains a non-canonical scalar', cause);
  }
  return Object.freeze({
    chainId: record.chainId,
    contractAddress: record.contractAddress,
  }) as Readonly<FinalizedVmLaneV1>;
}

/** Snapshot the trusted single-lane network profile before row iteration begins. */
export function snapshotFinalizedVmSetScopeV1(
  input: FinalizedVmSetScopeV1,
): Readonly<FinalizedVmSetScopeV1> {
  const record = snapshotRecord(
    input,
    FINALIZED_VM_SET_SCOPE_KEYS,
    'finalized VM-set scope',
  );
  try {
    assertNetworkIdV1(record.networkId, 'scope.networkId');
    assertCanonicalChainId(record.chainId, 'scope.chainId');
    assertCanonicalEvmAddress(record.contractAddress, 'scope.contractAddress');
  } catch (cause) {
    fail('finalized-vm-set-scalar', 'finalized VM-set scope contains a non-canonical scalar', cause);
  }
  return Object.freeze({
    networkId: record.networkId,
    chainId: record.chainId,
    contractAddress: record.contractAddress,
  }) as Readonly<FinalizedVmSetScopeV1>;
}

/**
 * Snapshot one row against the complete trusted scope, rejecting accessors,
 * non-canonical aliases, UAL namespace drift, and cross-lane rows in one boundary.
 */
export function snapshotFinalizedVmSetRowV1(
  scopeInput: FinalizedVmSetScopeV1,
  input: FinalizedVmSetRowV1,
): Readonly<FinalizedVmSetRowV1> {
  const scope = snapshotFinalizedVmSetScopeV1(scopeInput);
  return snapshotFinalizedVmSetRowForScopeV1(scope, input).row;
}

function snapshotFinalizedVmSetRowForScopeV1(
  scope: Readonly<FinalizedVmSetScopeV1>,
  input: FinalizedVmSetRowV1,
): ValidatedFinalizedVmSetRowV1 {
  const record = snapshotRecord(input, FINALIZED_VM_SET_ROW_KEYS, 'finalized VM row');
  let ordinalValue: bigint;
  let assertionVersionValue: bigint;
  try {
    assertCanonicalChainId(record.chainId, 'row.chainId');
    assertCanonicalEvmAddress(record.contractAddress, 'row.contractAddress');
    assertCanonicalDecimalU64(record.ordinal, 'row.ordinal');
    ordinalValue = parseCanonicalDecimalU64(record.ordinal, 'row.ordinal');
    assertCanonicalEvmAddress(record.authorAddress, 'row.authorAddress');
    assertCanonicalDecimalU64(record.assertionVersion, 'row.assertionVersion');
    assertionVersionValue = parseCanonicalDecimalU64(
      record.assertionVersion,
      'row.assertionVersion',
    );
    if (assertionVersionValue === 0n) {
      fail('finalized-vm-set-scalar', 'row.assertionVersion must be positive');
    }
    assertCanonicalDigest(record.assertionRoot, 'row.assertionRoot');
    assertCanonicalDecimalU64(record.finalizedBlockNumber, 'row.finalizedBlockNumber');
    assertCanonicalDigest(record.finalizedBlockHash, 'row.finalizedBlockHash');
    assertCanonicalDigest(record.placementEvidenceDigest, 'row.placementEvidenceDigest');
  } catch (cause) {
    if (cause instanceof FinalizedVmSetV1Error) throw cause;
    fail('finalized-vm-set-scalar', 'finalized VM row contains a non-canonical scalar', cause);
  }

  if (typeof record.ual !== 'string') {
    fail('finalized-vm-set-ual', 'row.ual must be a canonical deterministic KA UAL');
  }
  if (
    record.ual.length > MAX_FINALIZED_VM_SET_UAL_BYTES_V1
    || UTF8.encode(record.ual).byteLength > MAX_FINALIZED_VM_SET_UAL_BYTES_V1
  ) {
    fail('finalized-vm-set-ual', 'row.ual exceeds the v10.0.8 deterministic UAL byte bound');
  }
  try {
    const parsed = parseDeterministicKnowledgeAssetUal(record.ual);
    if (parsed.ual !== record.ual) {
      fail('finalized-vm-set-ual', 'row.ual must not use a non-canonical identity alias');
    }
    if (parsed.agentAddress !== record.authorAddress) {
      fail('finalized-vm-set-ual', 'row.ual author differs from row.authorAddress');
    }
    const ualNetworkId = parsed.chainId;
    if (ualNetworkId !== scope.networkId) {
      fail('finalized-vm-set-ual', 'row.ual namespace differs from the trusted network profile');
    }
  } catch (cause) {
    if (cause instanceof FinalizedVmSetV1Error) throw cause;
    fail('finalized-vm-set-ual', 'row.ual is not a canonical deterministic KA UAL', cause);
  }

  if (record.chainId !== scope.chainId || record.contractAddress !== scope.contractAddress) {
    fail('finalized-vm-set-lane', 'finalized VM row differs from the trusted scope lane');
  }

  const row = Object.freeze({
    chainId: record.chainId,
    contractAddress: record.contractAddress,
    ordinal: record.ordinal,
    ual: record.ual,
    authorAddress: record.authorAddress,
    assertionVersion: record.assertionVersion,
    assertionRoot: record.assertionRoot,
    finalizedBlockNumber: record.finalizedBlockNumber,
    finalizedBlockHash: record.finalizedBlockHash,
    placementEvidenceDigest: record.placementEvidenceDigest,
  }) as CanonicalFinalizedVmSetRowV1;
  return Object.freeze({ row, ordinalValue });
}

/** Compute the exact domain-separated RFC-64 leaf digest for one placed row. */
export function computeFinalizedVmSetLeafDigestV1(
  scope: FinalizedVmSetScopeV1,
  row: FinalizedVmSetRowV1,
): Digest32V1 {
  const trustedScope = snapshotFinalizedVmSetScopeV1(scope);
  const validated = snapshotFinalizedVmSetRowForScopeV1(trustedScope, row);
  return digestBytesToLowerHex(computeFinalizedVmSetLeafDigestBytesV1(validated.row));
}

/** The canonical finalized-VM empty accumulator root. */
export function computeEmptyFinalizedVmSetRootV1(): Digest32V1 {
  return digestBytesToLowerHex(digestBytes(EMPTY_DOMAIN_BYTES));
}

/**
 * Streaming per-lane VM-set accumulator.
 *
 * Rows must arrive in strictly increasing unsigned ordinal order, matching an
 * indexed planner stream. Memory stays O(log rowCount); the helper never sorts
 * or buffers the VM inventory and therefore cannot hide duplicate ordinals.
 */
export class FinalizedVmSetAccumulatorV1 {
  readonly #scope: Readonly<FinalizedVmSetScopeV1>;
  readonly #frontier = new FinalizedVmSetMerkleFrontier();
  #rowCount = 0n;
  #highestFinalizedOrdinal: DecimalU64V1 | null = null;
  #highestOrdinalValue: bigint | null = null;
  #finalEvidence: FinalizedVmSetEvidenceV1 | undefined;
  #appendInProgress = false;

  constructor(scope: FinalizedVmSetScopeV1) {
    this.#scope = snapshotFinalizedVmSetScopeV1(scope);
  }

  append(rowInput: FinalizedVmSetRowV1): void {
    if (this.#finalEvidence !== undefined) {
      fail('finalized-vm-set-state', 'cannot append after the VM-set accumulator is finalized');
    }
    if (this.#appendInProgress) {
      fail('finalized-vm-set-state', 'cannot re-enter a finalized VM-set append');
    }
    this.#appendInProgress = true;
    try {
      if (this.#rowCount >= MAX_DECIMAL_U64) {
        fail('finalized-vm-set-state', 'finalized VM row count exceeds the u64 range');
      }

      const validated = snapshotFinalizedVmSetRowForScopeV1(this.#scope, rowInput);
      if (
        this.#highestOrdinalValue !== null
        && validated.ordinalValue <= this.#highestOrdinalValue
      ) {
        fail('finalized-vm-set-order', 'finalized VM rows must have unique increasing ordinals');
      }

      this.#frontier.append(computeFinalizedVmSetLeafDigestBytesV1(validated.row));
      this.#rowCount += 1n;
      this.#highestOrdinalValue = validated.ordinalValue;
      this.#highestFinalizedOrdinal = validated.row.ordinal;
    } finally {
      this.#appendInProgress = false;
    }
  }

  finalize(): FinalizedVmSetEvidenceV1 {
    if (this.#appendInProgress) {
      fail('finalized-vm-set-state', 'cannot finalize during a finalized VM-set append');
    }
    if (this.#finalEvidence !== undefined) return this.#finalEvidence;

    this.#finalEvidence = Object.freeze({
      scope: this.#scope,
      rootDigest: digestBytesToLowerHex(this.#frontier.finalizeRoot()),
      rowCount: this.#rowCount.toString() as DecimalU64V1,
      highestFinalizedOrdinal: this.#highestFinalizedOrdinal,
    });
    return this.#finalEvidence;
  }
}

/** Convenience wrapper over the streaming accumulator; input order remains authoritative. */
export function computeFinalizedVmSetEvidenceV1(
  scope: FinalizedVmSetScopeV1,
  rows: Iterable<FinalizedVmSetRowV1>,
): FinalizedVmSetEvidenceV1 {
  const accumulator = new FinalizedVmSetAccumulatorV1(scope);
  for (const row of rows) accumulator.append(row);
  return accumulator.finalize();
}

function computeFinalizedVmSetLeafDigestBytesV1(
  row: CanonicalFinalizedVmSetRowV1,
): Uint8Array {
  return digestBytes(
    LEAF_DOMAIN_BYTES,
    canonicalizeJsonBytes(row, {
      maxBytes: 2 * 1024,
      maxDepth: 2,
    }),
  );
}

/** Feature-local frontier for the fixed finalized-VM set digest domains. */
class FinalizedVmSetMerkleFrontier {
  readonly #levels: Array<Uint8Array | undefined> = [];
  #finalRoot: Uint8Array | undefined;

  append(leafDigest: Uint8Array): void {
    if (this.#finalRoot !== undefined) {
      fail('finalized-vm-set-state', 'cannot append to a finalized Merkle frontier');
    }
    let current = leafDigest;
    let level = 0;
    while (this.#levels[level] !== undefined) {
      current = digestBytes(NODE_DOMAIN_BYTES, this.#levels[level]!, current);
      this.#levels[level] = undefined;
      level += 1;
    }
    this.#levels[level] = current;
  }

  finalizeRoot(): Uint8Array {
    if (this.#finalRoot !== undefined) return this.#finalRoot;

    let pending: Uint8Array | undefined;
    let pendingLevel = -1;
    for (let level = 0; level < this.#levels.length; level += 1) {
      const left = this.#levels[level];
      if (left === undefined) continue;
      if (pending === undefined) {
        pending = left;
        pendingLevel = level;
        continue;
      }
      while (pendingLevel < level) {
        pending = digestBytes(ODD_DOMAIN_BYTES, pending);
        pendingLevel += 1;
      }
      pending = digestBytes(NODE_DOMAIN_BYTES, left, pending);
      pendingLevel = level + 1;
    }
    this.#finalRoot = pending ?? digestBytes(EMPTY_DOMAIN_BYTES);
    return this.#finalRoot;
  }
}

function snapshotRecord<const Keys extends readonly string[]>(
  input: unknown,
  expectedKeys: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  try {
    return snapshotExactDataRecord(input, expectedKeys, label);
  } catch (cause) {
    fail(
      'finalized-vm-set-schema',
      cause instanceof Error ? cause.message : `${label} is not an exact data record`,
      cause,
    );
  }
}

function digestBytes(domain: Uint8Array, ...chunks: readonly Uint8Array[]): Uint8Array {
  const hasher = sha256.create();
  hasher.update(domain);
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digest();
}

function digestBytesToLowerHex(bytes: Uint8Array): Digest32V1 {
  let value = '0x';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(value);
  return value;
}

function fail(
  code: FinalizedVmSetV1ErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new FinalizedVmSetV1Error(code, message, cause === undefined ? {} : { cause });
}
