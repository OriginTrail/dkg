// SPDX-License-Identifier: Apache-2.0

/**
 * Historical Context Graph discovery by ContextGraphStorage id enumeration.
 *
 * `ContextGraphStorage` mints sequential ids and `getLatestContextGraphId()`
 * returns the counter, so every Context Graph that exists on chain can be
 * listed with view calls alone: no `eth_getLogs`, no archive state, and no
 * deploy-block anchor. That matters on the default public RPCs, which cap log
 * ranges or reject older blocks, and it replaces the `NameClaimed` scan of the
 * archived ContextGraphNameRegistry, which is not registered in the Hub on
 * either mainnet.
 *
 * One call reads one bounded id range with every read pinned to ONE block:
 * the node's finality anchor (`chain.finalityConfirmations`, resolved by
 * `resolveEvmFinalityAnchorBlockV1`, the same anchor the authority snapshot
 * uses). A range is therefore internally coherent, and a caller's durable
 * cursor never advances over state this node would not believe. The facts are
 * a discovery catalog, not authority: every consumer that acts on a graph
 * (subscribe, publish, SWM admission) re-reads authority through its own path.
 *
 * Cost per call: one head block read (plus one anchor block read when
 * `finalityConfirmations` > 1), one `getLatestContextGraphId`, then two
 * `eth_call`s per id (`getContextGraph` + `getNameHash`).
 */

import { ethers } from 'ethers';

import type {
  ContextGraphStorageEntry,
  ContextGraphStorageRange,
  ContextGraphStorageRangeOptions,
} from './chain-adapter.js';
import { isContractViewRetryable } from './rpc-failover-client.js';

/**
 * RPC usage consumer for every read issued by one enumeration range. It bills
 * to the existing chain-discovery consumer: this read replaces the
 * `NameClaimed` scan as the way the node lists Context Graphs from chain, and
 * the closed usage vocabulary already carries (and operators already chart)
 * that label.
 */
export const CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER = 'listContextGraphsFromChain';

/** Ids read concurrently within one range; the RPC governor paces the rest. */
export const CONTEXT_GRAPH_STORAGE_ENUMERATION_CONCURRENCY = 4;

/** Hard cap on ids per call, so one call stays a bounded unit of work. */
export const CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ = 256;

/**
 * Positional layout of `ContextGraphStorage.getContextGraph(uint256)`:
 * `(owner, participantAgents, metadataBatchId, active, createdAt,
 * accessPolicy, publishPolicy, publishAuthority, publishAuthorityAccountId)`.
 * Decoding by position keeps this independent of the output names in the ABI.
 */
const TUPLE = {
  owner: 0,
  active: 3,
  createdAt: 4,
  accessPolicy: 5,
  publishPolicy: 6,
  publishAuthority: 7,
} as const;

/** Anchor block identity every read in one range is pinned to. */
export interface ContextGraphStorageAnchorBlock {
  readonly number: number;
  readonly hash: string;
}

/**
 * Chain access for one range. The EVM adapter binds these to its governed,
 * failover-aware read paths; tests bind them to fakes.
 */
export interface ContextGraphStorageRangePorts {
  /** Lowercase ContextGraphStorage address. */
  readonly storageAddress: string;
  /** Resolve the finality anchor block from one endpoint. */
  readAnchor(): Promise<ContextGraphStorageAnchorBlock>;
  /** `getLatestContextGraphId()` at `blockTag`. */
  readLatestId(blockTag: number): Promise<unknown>;
  /** Raw `getContextGraph(id)` result at `blockTag`. */
  readContextGraph(contextGraphId: bigint, blockTag: number): Promise<unknown>;
  /** Raw `getNameHash(id)` result at `blockTag`. */
  readNameHash(contextGraphId: bigint, blockTag: number): Promise<unknown>;
  /** True only for a revert that proves THIS id was never minted. */
  isNonexistentContextGraph(error: unknown, contextGraphId: bigint): boolean;
}

export class ContextGraphStorageEnumerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextGraphStorageEnumerationError';
  }
}

/**
 * Read `[fromId, min(latestId, fromId + maxIds - 1)]` at one anchor block.
 * Throws on any read or decode failure: a caller must not advance a cursor
 * over a range it could not read completely.
 *
 * An id at or below `latestId` that nevertheless reads as nonexistent ends the
 * range there instead of being skipped. Ids are sequential and never burned,
 * so that can only mean the serving backend has not caught up with the anchor;
 * the next call retries the same id rather than moving a cursor past it.
 */
export async function readContextGraphStorageRangeV1(
  ports: ContextGraphStorageRangePorts,
  options: ContextGraphStorageRangeOptions,
): Promise<ContextGraphStorageRange> {
  const { fromId, maxIds, signal } = options;
  if (typeof fromId !== 'bigint' || fromId < 1n) {
    throw new RangeError('readContextGraphStorageRange: fromId must be a bigint >= 1');
  }
  if (
    !Number.isSafeInteger(maxIds)
    || maxIds < 1
    || maxIds > CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ
  ) {
    throw new RangeError(
      `readContextGraphStorageRange: maxIds must be an integer in [1, ${CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ}]`,
    );
  }
  signal?.throwIfAborted();

  const anchor = await ports.readAnchor();
  signal?.throwIfAborted();
  const latestId = decodeUint(
    await ports.readLatestId(anchor.number),
    'getLatestContextGraphId',
  );
  signal?.throwIfAborted();

  const lastId = fromId + BigInt(maxIds) - 1n < latestId
    ? fromId + BigInt(maxIds) - 1n
    : latestId;
  const ids: bigint[] = [];
  for (let id = fromId; id <= lastId; id += 1n) ids.push(id);

  const slots: Array<ContextGraphStorageEntry | undefined> = Array.from({ length: ids.length });
  // Index of the first id that read as nonexistent; nothing at or after it is
  // returned, and workers stop claiming ids beyond it.
  let stopAt = ids.length;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= stopAt) return;
      const entry = await readEntry(ports, ids[index]!, anchor.number);
      if (entry === null) {
        stopAt = Math.min(stopAt, index);
        continue;
      }
      slots[index] = entry;
    }
  };
  const workers = Math.min(CONTEXT_GRAPH_STORAGE_ENUMERATION_CONCURRENCY, ids.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  signal?.throwIfAborted();

  const entries = slots.slice(0, stopAt) as ContextGraphStorageEntry[];
  return Object.freeze({
    storageAddress: ports.storageAddress.toLowerCase(),
    anchorBlockNumber: anchor.number,
    anchorBlockHash: anchor.hash.toLowerCase(),
    latestId,
    entries: Object.freeze(entries),
    nextId: fromId + BigInt(entries.length),
  });
}

async function readEntry(
  ports: ContextGraphStorageRangePorts,
  contextGraphId: bigint,
  blockTag: number,
): Promise<ContextGraphStorageEntry | null> {
  let raw: unknown;
  let rawNameHash: unknown;
  try {
    [raw, rawNameHash] = await Promise.all([
      ports.readContextGraph(contextGraphId, blockTag),
      ports.readNameHash(contextGraphId, blockTag),
    ]);
  } catch (error) {
    // `getContextGraph` reverts only through `_requireExists`.
    if (ports.isNonexistentContextGraph(error, contextGraphId)) return null;
    throw error;
  }
  return decodeContextGraphStorageEntryV1(contextGraphId, raw, rawNameHash);
}

/** Validate one raw `getContextGraph` tuple plus its `getNameHash` word. */
export function decodeContextGraphStorageEntryV1(
  contextGraphId: bigint,
  raw: unknown,
  rawNameHash: unknown,
): ContextGraphStorageEntry {
  const label = `getContextGraph(${contextGraphId.toString(10)})`;
  if (raw === null || typeof raw !== 'object' || !('length' in raw)) {
    throw new ContextGraphStorageEnumerationError(`${label} returned a non-tuple result`);
  }
  const tuple = raw as ArrayLike<unknown>;
  const owner = decodeAddress(tuple[TUPLE.owner], `${label}.owner`);
  if (owner === null) {
    throw new ContextGraphStorageEnumerationError(`${label} returned the zero owner`);
  }
  const active = tuple[TUPLE.active];
  if (typeof active !== 'boolean') {
    throw new ContextGraphStorageEnumerationError(`${label}.active is not a boolean`);
  }
  const createdAt = decodeUint(tuple[TUPLE.createdAt], `${label}.createdAt`);
  if (createdAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ContextGraphStorageEnumerationError(`${label}.createdAt is out of range`);
  }
  const accessPolicy = decodeUint(tuple[TUPLE.accessPolicy], `${label}.accessPolicy`);
  const publishPolicy = decodeUint(tuple[TUPLE.publishPolicy], `${label}.publishPolicy`);
  if (accessPolicy > 255n || publishPolicy > 255n) {
    throw new ContextGraphStorageEnumerationError(`${label} returned an out-of-range policy`);
  }
  return Object.freeze({
    contextGraphId: contextGraphId.toString(10),
    owner,
    active,
    createdAt: Number(createdAt),
    accessPolicy: Number(accessPolicy),
    publishPolicy: Number(publishPolicy),
    publishAuthority: decodeAddress(tuple[TUPLE.publishAuthority], `${label}.publishAuthority`),
    nameHash: decodeNameHash(rawNameHash, contextGraphId),
  });
}

function decodeUint(value: unknown, label: string): bigint {
  let decoded: bigint;
  try {
    decoded = typeof value === 'bigint' ? value : BigInt(value as string | number);
  } catch (cause) {
    throw new ContextGraphStorageEnumerationError(`${label} is not an unsigned integer`, { cause });
  }
  if (decoded < 0n) {
    throw new ContextGraphStorageEnumerationError(`${label} is negative`);
  }
  return decoded;
}

function decodeAddress(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || !ethers.isAddress(value)) {
    throw new ContextGraphStorageEnumerationError(`${label} is not an address`);
  }
  const lower = value.toLowerCase();
  return lower === ethers.ZeroAddress ? null : lower;
}

function decodeNameHash(value: unknown, contextGraphId: bigint): string | null {
  if (typeof value !== 'string' || !ethers.isHexString(value, 32)) {
    throw new ContextGraphStorageEnumerationError(
      `getNameHash(${contextGraphId.toString(10)}) is not a bytes32 value`,
    );
  }
  const lower = value.toLowerCase();
  // The curator opted out of the name commitment at creation.
  return lower === ethers.ZeroHash ? null : lower;
}

/**
 * Endpoint-failover classifier for enumeration view reads.
 *
 * ethers v6 turns ANY JSON-RPC error on `eth_call` into a CALL_EXCEPTION, so a
 * load-balanced backend that has not yet imported the pinned anchor block
 * ("header not found") surfaces as a CALL_EXCEPTION with no revert data, which
 * the shared classifier treats as a deterministic failure. The three views
 * read here only ever revert with a typed error that carries data, so a
 * data-less CALL_EXCEPTION proves nothing and may try the next endpoint.
 */
export function isContextGraphStorageEnumerationReadRetryable(error: unknown): boolean {
  if (isContractViewRetryable(error)) return true;
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; data?: unknown; revert?: unknown };
  return e.code === 'CALL_EXCEPTION'
    && (e.data === null || e.data === undefined || e.data === '0x')
    && (e.revert === null || e.revert === undefined);
}

const ERC721_NONEXISTENT_TOKEN_INTERFACE = new ethers.Interface([
  'error ERC721NonexistentToken(uint256 tokenId)',
]);

/**
 * Id-exact `ERC721NonexistentToken` match, decoded or raw. Mirrors the live
 * authority read's matcher: a revert naming another token, or any other
 * failure, proves nothing about this id and must propagate.
 */
export function isNonexistentContextGraphStorageRevert(
  error: unknown,
  contextGraphId: bigint,
): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; revert?: unknown; data?: unknown; errorData?: unknown };
  if (e.code !== 'CALL_EXCEPTION') return false;
  const revert = e.revert as { name?: unknown; args?: unknown } | null | undefined;
  if (revert !== null && typeof revert === 'object' && revert.name === 'ERC721NonexistentToken') {
    const named = (revert.args as ArrayLike<unknown> | null | undefined)?.[0];
    try {
      return named !== undefined && named !== null
        && BigInt(named as string | number | bigint) === contextGraphId;
    } catch {
      return false;
    }
  }
  const expected = ERC721_NONEXISTENT_TOKEN_INTERFACE
    .encodeErrorResult('ERC721NonexistentToken', [contextGraphId])
    .toLowerCase();
  for (const candidate of [e.data, e.errorData]) {
    if (typeof candidate === 'string' && candidate.toLowerCase() === expected) return true;
  }
  return false;
}
