import { sha256 } from '@noble/hashes/sha2.js';

import { assertNetworkIdV1, type NetworkIdV1 } from './author-catalog-codec.js';
import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { parseDeterministicKnowledgeAssetUal } from './ka-content-scope.js';
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
  const record = snapshotExactDataRecord(input, FINALIZED_VM_LANE_KEYS, 'finalized VM lane');
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
  const record = snapshotExactDataRecord(
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
 * Snapshot one row exactly once, rejecting accessors and non-canonical aliases.
 * The returned object is safe to retain across hashing or I/O callbacks.
 */
export function snapshotFinalizedVmSetRowV1(
  input: FinalizedVmSetRowV1,
  expectedNetworkId: NetworkIdV1,
): Readonly<FinalizedVmSetRowV1> {
  try {
    assertNetworkIdV1(expectedNetworkId, 'expectedNetworkId');
  } catch (cause) {
    fail('finalized-vm-set-scalar', 'trusted network profile is not canonical', cause);
  }
  const record = snapshotExactDataRecord(input, FINALIZED_VM_SET_ROW_KEYS, 'finalized VM row');
  try {
    assertCanonicalChainId(record.chainId, 'row.chainId');
    assertCanonicalEvmAddress(record.contractAddress, 'row.contractAddress');
    assertCanonicalDecimalU64(record.ordinal, 'row.ordinal');
    assertCanonicalEvmAddress(record.authorAddress, 'row.authorAddress');
    assertCanonicalDecimalU64(record.assertionVersion, 'row.assertionVersion');
    if (parseCanonicalDecimalU64(record.assertionVersion, 'row.assertionVersion') === 0n) {
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
    if (parsed.chainId !== expectedNetworkId) {
      fail('finalized-vm-set-ual', 'row.ual namespace differs from the trusted network profile');
    }
  } catch (cause) {
    if (cause instanceof FinalizedVmSetV1Error) throw cause;
    fail('finalized-vm-set-ual', 'row.ual is not a canonical deterministic KA UAL', cause);
  }

  return Object.freeze({
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
  }) as Readonly<FinalizedVmSetRowV1>;
}

/** Compute the exact domain-separated RFC-64 leaf digest for one placed row. */
export function computeFinalizedVmSetLeafDigestV1(
  scope: FinalizedVmSetScopeV1,
  row: FinalizedVmSetRowV1,
): Digest32V1 {
  const trustedScope = snapshotFinalizedVmSetScopeV1(scope);
  const snapshot = snapshotFinalizedVmSetRowV1(row, trustedScope.networkId);
  if (
    snapshot.chainId !== trustedScope.chainId
    || snapshot.contractAddress !== trustedScope.contractAddress
  ) {
    fail('finalized-vm-set-lane', 'finalized VM row differs from the trusted scope lane');
  }
  return digestBytesToLowerHex(computeFinalizedVmSetLeafDigestBytesV1(snapshot));
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
  readonly #levels: Array<Uint8Array | undefined> = [];
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

      const row = snapshotFinalizedVmSetRowV1(rowInput, this.#scope.networkId);
      if (
        row.chainId !== this.#scope.chainId
        || row.contractAddress !== this.#scope.contractAddress
      ) {
        fail('finalized-vm-set-lane', 'finalized VM row differs from the accumulator lane');
      }
      const ordinal = parseCanonicalDecimalU64(row.ordinal, 'row.ordinal');
      if (this.#highestOrdinalValue !== null && ordinal <= this.#highestOrdinalValue) {
        fail('finalized-vm-set-order', 'finalized VM rows must have unique increasing ordinals');
      }

      let current = computeFinalizedVmSetLeafDigestBytesV1(row);
      let level = 0;
      while (this.#levels[level] !== undefined) {
        current = digestBytes(NODE_DOMAIN_BYTES, this.#levels[level]!, current);
        this.#levels[level] = undefined;
        level += 1;
      }
      this.#levels[level] = current;
      this.#rowCount += 1n;
      this.#highestOrdinalValue = ordinal;
      this.#highestFinalizedOrdinal = row.ordinal;
    } finally {
      this.#appendInProgress = false;
    }
  }

  finalize(): FinalizedVmSetEvidenceV1 {
    if (this.#appendInProgress) {
      fail('finalized-vm-set-state', 'cannot finalize during a finalized VM-set append');
    }
    if (this.#finalEvidence !== undefined) return this.#finalEvidence;

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

    const rootDigest = pending === undefined
      ? computeEmptyFinalizedVmSetRootV1()
      : digestBytesToLowerHex(pending);
    this.#finalEvidence = Object.freeze({
      scope: this.#scope,
      rootDigest,
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
  row: Readonly<FinalizedVmSetRowV1>,
): Uint8Array {
  return digestBytes(
    LEAF_DOMAIN_BYTES,
    canonicalizeJsonBytes(row as unknown as CanonicalJsonValue, {
      maxBytes: 2 * 1024,
      maxDepth: 2,
    }),
  );
}

function snapshotExactDataRecord<const Keys extends readonly string[]>(
  input: unknown,
  expectedKeys: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('finalized-vm-set-schema', `${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('finalized-vm-set-schema', `${label} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('finalized-vm-set-schema', `${label} must not contain symbol fields`);
  }
  const strings = keys as string[];
  if (
    strings.length !== expectedKeys.length
    || expectedKeys.some((key) => !strings.includes(key))
  ) {
    fail('finalized-vm-set-schema', `${label} has unknown or missing fields`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('finalized-vm-set-schema', `${label}.${key} must be an enumerable data field`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as Readonly<Record<Keys[number], unknown>>;
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
