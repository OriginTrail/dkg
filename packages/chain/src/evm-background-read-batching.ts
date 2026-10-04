// SPDX-License-Identifier: Apache-2.0

/**
 * Background contract views through Multicall3.
 *
 * Background work (the chain-driven VM catch-up above all) reads the same few
 * views for one Knowledge Asset after another, and each read is one request
 * against the node's background request budget. Here those reads leave in one
 * `aggregate3` call: one request, every inner view evaluated at one block.
 *
 * What is batched is deliberately narrow:
 * - only the views named in {@link BATCHABLE_BACKGROUND_READ_LABELS}: plain
 *   storage reads that do not depend on the caller's address;
 * - only in the background request class, so a foreground read (a publish, an
 *   API request) is issued exactly as before;
 * - only with the default read policy, since a batch is one request with one
 *   policy;
 * - only where the canonical Multicall3 bytecode is deployed. The address is
 *   the same on every chain that has it, and the code there is checked by hash
 *   before the first batch. A chain without it, or with something else at
 *   that address, keeps the direct reads and is looked at again every ten
 *   minutes.
 *
 * Everything the batch cannot answer with a decoded value is answered by the
 * direct read itself (see `contract-read-batcher.ts`).
 */

import { Contract, ethers } from 'ethers';
import type { JsonRpcProvider } from 'ethers';

import {
  ContractReadBatcher,
  type BatchedContractCall,
  type BatchedContractCallResult,
  type ContractReadBatchObservation,
} from './contract-read-batcher.js';
import {
  createRpcReadDescriptor,
  type ReadOpts,
  type RpcReadDescriptor,
} from './rpc-failover-client.js';
import { isRpcRequestGovernorQueueFullError } from './rpc-request-governor.js';
import {
  activeRpcRequestContext,
  bindActiveRpcRequestScope,
  withDetachedRpcRequestContext,
} from './rpc-request-transport.js';

/** Multicall3 is deployed at this address on every chain that has it. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** keccak256 of the canonical Multicall3 runtime bytecode (3,808 bytes). */
export const MULTICALL3_RUNTIME_CODE_HASH =
  '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
] as const;

/** The physical request's label and usage consumer. */
export const MULTICALL3_AGGREGATE_READ = 'multicall3.aggregate3';
const MULTICALL3_CODE_READ = 'multicall3.getCode';

/**
 * Views that may leave in a batch: plain per-asset and per-graph storage
 * reads, each a bounded read label the direct path already uses.
 */
export const BATCHABLE_BACKGROUND_READ_LABELS: ReadonlySet<string> = new Set([
  'cgStorage.kaToContextGraph',
  'cgStorage.getContextGraphKaAt',
  'cgStorage.getContextGraphKaCount',
  'kas.getLatestMerkleRoot',
  'kas.getKnowledgeAssetUpdateContext',
  'kas.getLatestMerkleRootPublisher',
  'kas.getLatestMerkleRootAuthor',
]);

/** How long a bytecode check that could not be read waits before the next one. */
const MULTICALL3_CHECK_RETRY_MS = 60_000;
/**
 * How long an answer of "not there" stands. One endpoint that answered for a
 * state it does not hold must not switch batching off for the process's
 * lifetime, and a chain without the contract pays one read per interval.
 */
const MULTICALL3_ABSENT_RECHECK_MS = 10 * 60_000;

export interface RpcReadBatchingWindow {
  /** Aggregate requests that answered. */
  readonly batches: number;
  /** Aggregate requests that failed; their reads went out directly. */
  readonly failedBatches: number;
  /** Aggregate requests the node's own request admission refused. */
  readonly refusedBatches: number;
  /** Inner calls carried by the requests that answered. */
  readonly calls: number;
  /** Reads handed to their direct path after a request. */
  readonly directReads: number;
  /** Reads sent in a request, by read label. */
  readonly readsByLabel: Readonly<Record<string, number>>;
}

interface MutableReadBatchingWindow {
  batches: number;
  failedBatches: number;
  refusedBatches: number;
  calls: number;
  directReads: number;
  readsByLabel: Map<string, number>;
}

function emptyReadBatchingWindow(): MutableReadBatchingWindow {
  return {
    batches: 0, failedBatches: 0, refusedBatches: 0, calls: 0, directReads: 0,
    readsByLabel: new Map(),
  };
}

// One process-wide window, like the request governor's: a daemon can own
// several adapters and reports them as one node.
let processWindow = emptyReadBatchingWindow();

function recordReadBatch(observation: ContractReadBatchObservation): void {
  if (observation.outcome === 'served') {
    processWindow.batches += 1;
    processWindow.calls += observation.calls;
  } else if (observation.outcome === 'failed') {
    processWindow.failedBatches += 1;
  } else {
    processWindow.refusedBatches += 1;
  }
  processWindow.directReads += observation.directReads;
  for (const [label, count] of observation.readsByLabel) {
    processWindow.readsByLabel.set(label, (processWindow.readsByLabel.get(label) ?? 0) + count);
  }
}

/** Read batching since the previous drain, for the daemon's usage log. */
export function drainRpcReadBatchingWindow(): RpcReadBatchingWindow {
  const drained = processWindow;
  processWindow = emptyReadBatchingWindow();
  return Object.freeze({
    batches: drained.batches,
    failedBatches: drained.failedBatches,
    refusedBatches: drained.refusedBatches,
    calls: drained.calls,
    directReads: drained.directReads,
    readsByLabel: Object.freeze(Object.fromEntries(drained.readsByLabel)),
  });
}

/** True for the canonical Multicall3 runtime bytecode and nothing else. */
export function isCanonicalMulticall3Code(code: unknown): boolean {
  if (typeof code !== 'string' || !ethers.isHexString(code) || code.length <= 2) return false;
  return ethers.keccak256(code) === MULTICALL3_RUNTIME_CODE_HASH;
}

/** The read options a batch can honour: cancellation only. */
function hasDefaultReadPolicy(opts: ReadOpts | undefined): boolean {
  if (opts === undefined) return true;
  return opts.policy === undefined
    && opts.isRetryable === undefined
    && opts.rpcUsageConsumer === undefined
    && opts.skipPreferred === undefined
    && opts.isEmptyResult === undefined
    && opts.endpointSetRetry === undefined
    && opts.deadlineMs === undefined;
}

export interface BackgroundContractReadBatchingDeps {
  /** The adapter's failover contract read. */
  readonly readContract: <T>(
    descriptor: RpcReadDescriptor,
    contract: Contract,
    fn: (contract: Contract) => Promise<T>,
    opts?: ReadOpts,
  ) => Promise<T>;
  /** The adapter's failover provider read. */
  readonly readProvider: <T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
  ) => Promise<T>;
  /** Kill switch, read on every call. */
  readonly isEnabled: () => boolean;
  readonly now?: () => number;
}

export interface BackgroundContractRead<T> {
  readonly contract: Contract;
  readonly label: string;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly opts?: ReadOpts;
  /** The read as the adapter issues it without batching. */
  readonly direct: () => Promise<T>;
}

/** Capped on every node: see the aggregate request. */
const MULTICALL3_AGGREGATE_READ_OPTS: ReadOpts = Object.freeze({ policy: 'watchdogPointRead' });

type Multicall3State = 'unchecked' | 'checking' | 'present';

export class BackgroundContractReadBatching {
  readonly #deps: BackgroundContractReadBatchingDeps;
  readonly #now: () => number;
  readonly #multicall3 = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI);
  readonly #descriptor = createRpcReadDescriptor(MULTICALL3_AGGREGATE_READ);
  readonly #batcher: ContractReadBatcher;
  #multicall3State: Multicall3State = 'unchecked';
  #checkNotBefore = 0;

  constructor(deps: BackgroundContractReadBatchingDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#batcher = new ContractReadBatcher({
      aggregate: (calls) => this.#aggregate(calls),
      isLocalRefusal: isRpcRequestGovernorQueueFullError,
      now: this.#now,
      observe: recordReadBatch,
    });
  }

  /**
   * Issue the read in a batch, or return `undefined` when it has to go out on
   * its own: the caller then runs `direct` itself, exactly as before.
   */
  tryRead<T>(read: BackgroundContractRead<T>): Promise<T> | undefined {
    if (!BATCHABLE_BACKGROUND_READ_LABELS.has(read.label)) return undefined;
    const request = activeRpcRequestContext();
    if (request.requestClass !== 'background') return undefined;
    if (!hasDefaultReadPolicy(read.opts) || !this.#deps.isEnabled()) return undefined;
    if (!this.#multicall3Present() || !this.#batcher.accepting) return undefined;
    const { target } = read.contract;
    if (typeof target !== 'string') return undefined;
    let fragment: ethers.FunctionFragment | null;
    let callData: string;
    try {
      fragment = read.contract.interface.getFunction(read.method);
      if (fragment === null) return undefined;
      callData = read.contract.interface.encodeFunctionData(fragment, read.args);
    } catch {
      // The direct read reports a bad method or argument as it always has.
      return undefined;
    }
    const contractInterface = read.contract.interface;
    const method = fragment;
    return this.#batcher.read<T>({
      label: read.label,
      target,
      callData,
      decode: (returnData) => {
        // A contract method call unwraps a single output; so does this.
        const result = contractInterface.decodeFunctionResult(method, returnData);
        return (result.length === 1 ? result[0] : result) as T;
      },
      // A fallback runs under its caller's own request policy and attribution.
      direct: bindActiveRpcRequestScope(read.direct),
      signals: [request.signal, read.opts?.signal],
      onBatched: () => {
        if (!request.signal?.aborted) request.onProgress?.();
      },
    });
  }

  #multicall3Present(): boolean {
    if (this.#multicall3State === 'present') return true;
    if (this.#multicall3State === 'unchecked' && this.#now() >= this.#checkNotBefore) {
      this.#multicall3State = 'checking';
      void this.#checkMulticall3();
    }
    return false;
  }

  async #checkMulticall3(): Promise<void> {
    let retryAfterMs = MULTICALL3_CHECK_RETRY_MS;
    try {
      // Adapter-owned: the check outlives, and is not cancelled by, the read that started it.
      const code = await withDetachedRpcRequestContext('background', () => this.#deps.readProvider(
        MULTICALL3_CODE_READ,
        (provider) => provider.getCode(MULTICALL3_ADDRESS),
      ));
      if (isCanonicalMulticall3Code(code)) {
        this.#multicall3State = 'present';
        return;
      }
      retryAfterMs = MULTICALL3_ABSENT_RECHECK_MS;
    } catch {
      // Unreadable: nothing is known about the chain yet.
    }
    this.#multicall3State = 'unchecked';
    this.#checkNotBefore = this.#now() + retryAfterMs;
  }

  async #aggregate(
    calls: readonly BatchedContractCall[],
  ): Promise<readonly BatchedContractCallResult[]> {
    // The request belongs to the adapter. No caller's cancellation, priority
    // or attribution may follow it: its callers wait on their own signals.
    // So nothing but its own policy bounds how long it stays out, and it has
    // somewhere to fall back to (the reads themselves) even on a node with one
    // endpoint, where a plain point read is left uncapped.
    const results = await withDetachedRpcRequestContext('background', () => this.#deps.readContract(
      this.#descriptor,
      this.#multicall3,
      (multicall3) => multicall3.aggregate3.staticCall(
        calls.map(({ target, callData }) => ({ target, allowFailure: true, callData })),
      ) as Promise<ReadonlyArray<{ success: unknown; returnData: unknown }>>,
      MULTICALL3_AGGREGATE_READ_OPTS,
    ));
    return results.map(({ success, returnData }) => ({
      success: success === true,
      returnData: String(returnData),
    }));
  }
}
