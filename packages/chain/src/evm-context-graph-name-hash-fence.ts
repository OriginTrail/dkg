// SPDX-License-Identifier: Apache-2.0

/**
 * Shared chain-snapshot and provider-consensus fences for Context Graph
 * name-hash reverse resolution. Both lookup lanes use this module so scope,
 * epoch, high-water, anchor, and exact-slot rules cannot drift apart.
 */

import { Contract, ethers, type JsonRpcProvider } from 'ethers';

import { CG_REGISTRY_MAX_SCAN_PAGES } from './evm-adapter-constants.js';
import { activeRpcRequestAbortSignal, withRpcRequestContext, withRpcRequestTimeout } from './rpc-request-transport.js';
import { isContractViewRetryable } from './rpc-failover-client.js';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';

/**
 * Maximum current high-water id for the fast getNameHash enumeration. Keep
 * the complete cold-path refresh tightly bounded under the default governor:
 * the range reads are accompanied by chain-id, high-water, and canonical-head
 * fences. Above this deliberately small threshold an exact-topic event scan
 * is substantially cheaper and avoids a multi-minute per-slot sweep.
 */
export const CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS = 64n;

/** Fixed pressure bound for the current-state getNameHash enumeration. */
export const CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY = 4;

/**
 * Queue-aware deadline for the fail-closed reverse-name lookup.
 *
 * The generic 4s point-read deadline is intentionally shorter than the RPC
 * governor's 30s background startup jitter. Using it here made a healthy,
 * admitted-later catalog bootstrap abort locally before its request could be
 * dispatched, then retry the same fenced lookup. The complete cold lookup is
 * already bounded by its caller; this per-read ceiling lets one request remain
 * queued through startup without weakening the resolver's chain fences.
 */
export const CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS = 60_000;

interface ContextGraphNameHashSlotScope {
  readonly storageAddress: string;
  readonly providers: readonly object[];
  readonly rpcUrls: readonly string[];
}

interface ContextGraphNameHashSlot {
  readonly id: bigint;
  readonly nameHash: string | null;
}

interface ContextGraphNameHashSlotAnchor {
  readonly blockNumber: number;
  readonly blockHash: string;
}

type ContextGraphNameHashCurrentResolution =
  | { readonly mode: 'current'; readonly bindings: ReadonlyMap<string, bigint | null>; readonly highWater: bigint }
  | { readonly mode: 'historical' };

interface ContextGraphNameHashSlotState {
  readonly scope: ContextGraphNameHashSlotScope;
  readonly highWater: bigint;
  readonly anchor: ContextGraphNameHashSlotAnchor;
  readonly idsByHash: ReadonlyMap<string, readonly bigint[]>;
}

export interface EvmContextGraphNameHashFenceDependencies {
  readonly initialize: () => Promise<void>;
  readonly requireContextGraphStorage: () => Contract;
  readonly providers: () => readonly JsonRpcProvider[];
  readonly rpcUrls: () => readonly string[];
  readonly ensureConfiguredStaticChainIdValidated: (
    provider: JsonRpcProvider,
  ) => Promise<bigint>;
  readonly rebindContract: (
    contract: Contract,
    provider: JsonRpcProvider,
  ) => Contract;
  readonly readLatestBlock: () => Promise<{
    readonly number: number;
    readonly hash: string | null;
  } | null>;
  readonly readAnchorHash: (blockNumber: number) => Promise<string | null>;
  readonly scanPageSize: () => number;
  readonly resolveContractDeployBlock: (
    address: string,
    operationLabel: string,
    contractLabel: string,
  ) => Promise<{
    readonly fromBlock: number;
    readonly head: number;
    readonly scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>;
    readonly degradedFromGenesis?: boolean;
  }>;
  readonly queryEventLogsPage: (
    baseContract: Contract,
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    label: string,
    preferred?: JsonRpcProvider,
    rpcUsageConsumer?: string,
  ) => Promise<{
    readonly logs: ReadonlyArray<ethers.EventLog | ethers.Log>;
    readonly provider: JsonRpcProvider;
  }>;
}

export interface ContextGraphNameHashProviderHighWaters {
  readonly latestId: bigint;
  readonly providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>;
  /** Providers whose transient high-water failure leaves slot coverage unknown. */
  readonly unavailableProviderCount: number;
}

export interface ContextGraphNameHashScopeToken {
  readonly epoch: number;
  readonly scope: ContextGraphNameHashSlotScope;
}

export interface ContextGraphNameHashHistoricalHeadAnchor<TProvider> {
  readonly head: number;
  readonly headHash: string;
  readonly scanProviders: readonly TProvider[];
}

export interface ContextGraphNameHashScanProvider {
  readonly provider: JsonRpcProvider;
  readonly backendHead: number;
}

export interface ContextGraphNameHashAnchoredHistoricalScan {
  readonly headAnchor: ContextGraphNameHashHistoricalHeadAnchor<
    ContextGraphNameHashScanProvider
  >;
  readonly readContextGraphCreatedPage: (
    nameHashFilter: string | null,
    lo: number,
    hi: number,
    preferred?: JsonRpcProvider,
  ) => Promise<{
    readonly bindings: readonly { readonly id: bigint; readonly nameHash: string }[];
    readonly provider: JsonRpcProvider;
  }>;
}

export interface ContextGraphNameHashHistoricalScan {
  readonly fromBlock: number;
  readonly head: number;
  readonly pageSize: number;
  readonly anchor: () => Promise<ContextGraphNameHashAnchoredHistoricalScan>;
}

/** High-level chain source; temporal fencing remains an implementation detail. */
export interface EvmContextGraphNameHashSource {
  /** Monotonic generation of committed current-slot snapshots. */
  readonly currentSlotRevision: number;
  resolve(normalizedNameHash: string): Promise<bigint | null>;
  resolveMany(normalizedNameHashes: readonly string[]): Promise<ReadonlyMap<string, bigint | null>>;
  invalidate(): void;
}

function sameScope(
  a: ContextGraphNameHashSlotScope,
  b: ContextGraphNameHashSlotScope,
): boolean {
  return a.storageAddress === b.storageAddress
    && a.providers.length === b.providers.length
    && a.providers.every((provider, index) => provider === b.providers[index])
    && a.rpcUrls.length === b.rpcUrls.length
    && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
}

function copyScope(
  scope: ContextGraphNameHashSlotScope,
): ContextGraphNameHashSlotScope {
  return {
    storageAddress: scope.storageAddress,
    providers: [...scope.providers],
    rpcUrls: [...scope.rpcUrls],
  };
}

function cloneIdsByHash(
  source: ReadonlyMap<string, readonly bigint[]> | undefined,
): Map<string, bigint[]> {
  return new Map(
    [...(source ?? [])].map(([nameHash, ids]) => [nameHash, [...ids]]),
  );
}

function appendSlots(
  idsByHash: Map<string, bigint[]>,
  slots: readonly ContextGraphNameHashSlot[],
  firstId: bigint,
  lastId: bigint,
): void {
  const expectedCount = lastId < firstId ? 0 : Number(lastId - firstId + 1n);
  if (slots.length !== expectedCount) {
    throw new Error(
      `resolveContextGraphIdByNameHash: current-slot refresh returned ` +
      `${slots.length} rows for ${expectedCount} ids`,
    );
  }
  const seen = new Set<bigint>();
  for (const slot of slots) {
    if (slot.id < firstId || slot.id > lastId || seen.has(slot.id)) {
      throw new Error(
        `resolveContextGraphIdByNameHash: invalid current-slot refresh id ` +
        `${slot.id.toString()} for range [${firstId.toString()}, ${lastId.toString()}]`,
      );
    }
    seen.add(slot.id);
    if (slot.nameHash === null || slot.nameHash === ethers.ZeroHash) continue;
    const normalized = slot.nameHash.toLowerCase();
    const ids = idsByHash.get(normalized) ?? [];
    ids.push(slot.id);
    idsByHash.set(normalized, ids);
  }
}

function waitForContextGraphSlotRead<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Context Graph slot read aborted'), { name: 'AbortError' }),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class EvmContextGraphNameHashFence implements EvmContextGraphNameHashSource {
  private bindingEpoch = 0;

  private currentSlotState: ContextGraphNameHashSlotState | undefined;

  private currentSlotTail: Promise<void> = Promise.resolve();

  private currentSlotGeneration = 0;

  get currentSlotRevision(): number {
    return this.currentSlotGeneration;
  }

  constructor(
    private readonly dependencies: EvmContextGraphNameHashFenceDependencies,
  ) {}

  private initialize(): Promise<void> {
    return this.dependencies.initialize();
  }

  invalidate(): void {
    this.bindingEpoch += 1;
    this.currentSlotState = undefined;
  }

  /**
   * Resolve through one cohesive chain-read boundary. The current and
   * historical lanes are private implementation details so callers cannot
   * accidentally omit or reorder a scope, high-water, or canonical-head
   * fence.
   */
  async resolve(normalizedNameHash: string): Promise<bigint | null> {
    await this.initialize();
    const requestScope = await this.captureScopeToken();
    // Admission for the first chain read must happen before this request owns
    // the serialized slot-state lane. In particular, background authority
    // discovery may be held by cold-start jitter; allowing that wait to own
    // currentSlotTail would invert priority and stall a foreground register.
    // The existing end-of-pass high-water verification makes a snapshot that
    // ages while queued fail closed without committing stale state.
    const highWaterSnapshot = await this.loadProviderHighWaters();
    const current = await this.enqueueCurrentSlotResolution(
      [normalizedNameHash],
      requestScope,
      highWaterSnapshot,
    );
    return current.mode === 'historical'
      ? this.resolveHistorical(normalizedNameHash)
      : current.bindings.get(normalizedNameHash)!;
  }

  /** Fresh batch proof; cached current slots still require all temporal fences. */
  async resolveMany(normalizedNameHashes: readonly string[]): Promise<ReadonlyMap<string, bigint | null>> {
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const names = normalizedNameHashes.filter((name) => name !== ethers.ZeroHash);
    if (names.length === 0) return new Map(normalizedNameHashes.map((name) => [name, null]));
    await this.initialize();
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const requestScope = await this.captureScopeToken();
    const highWaterSnapshot = await this.loadProviderHighWaters();
    const current = await this.enqueueCurrentSlotResolution(names, requestScope, highWaterSnapshot);
    const bindings = current.mode === 'historical'
      ? await this.resolveHistoricalMany(names, null)
      : current.bindings;
    activeRpcRequestAbortSignal()?.throwIfAborted();
    return new Map(normalizedNameHashes.map((name) => {
      if (name === ethers.ZeroHash) return [name, null] as const;
      const binding = bindings.get(name);
      if (binding === undefined) {
        throw new Error(`resolveContextGraphIdsByNameHashes: incomplete name binding for ${name}`);
      }
      return [name, binding] as const;
    }));
  }

  /** Serialize complete current-slot resolutions onto the one adapter-owned index. */
  private enqueueCurrentSlotResolution(
    normalizedNameHashes: readonly string[],
    requestScope: ContextGraphNameHashScopeToken,
    highWaterSnapshot: ContextGraphNameHashProviderHighWaters,
  ): Promise<ContextGraphNameHashCurrentResolution> {
    const run = this.currentSlotTail.then(
      () => this.resolveCurrentSlots(normalizedNameHashes, requestScope, highWaterSnapshot),
      () => this.resolveCurrentSlots(normalizedNameHashes, requestScope, highWaterSnapshot),
    );
    this.currentSlotTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Own the complete bounded current-slot refresh, commit, and verification
   * sequence without delegating chain reads back through a generic callback
   * layer.
   */
  private async resolveCurrentSlots(
    normalizedNameHashes: readonly string[],
    requestScope: ContextGraphNameHashScopeToken,
    highWaterSnapshot: ContextGraphNameHashProviderHighWaters,
  ): Promise<ContextGraphNameHashCurrentResolution> {
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const { latestId } = highWaterSnapshot;
    if (latestId < 0n) {
      throw new Error(
        `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
        `invalid negative id ${latestId.toString()}`,
      );
    }
    if (latestId > CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS) {
      return { mode: 'historical' };
    }

    const previous = this.currentSlotState;
    let rebuild = previous === undefined
      || !sameScope(previous.scope, requestScope.scope)
      || latestId < previous.highWater;
    if (!rebuild && previous !== undefined) {
      const currentAnchorHash = await this.loadAnchorHash(previous.anchor.blockNumber);
      rebuild = currentAnchorHash?.toLowerCase() !== previous.anchor.blockHash;
    }

    const firstId = rebuild ? 1n : (previous?.highWater ?? 0n) + 1n;
    const nextAnchor = rebuild || firstId <= latestId
      ? await this.captureAnchor()
      : previous?.anchor;
    const staged = firstId <= latestId
      ? await this.loadSlots(firstId, latestId, highWaterSnapshot)
      : [];

    if (nextAnchor === undefined) {
      throw new Error(
        'resolveContextGraphIdByNameHash: current-slot refresh has no chain anchor',
      );
    }
    if (rebuild || staged.length > 0) {
      const currentAnchorHash = await this.loadAnchorHash(nextAnchor.blockNumber);
      if (currentAnchorHash?.toLowerCase() !== nextAnchor.blockHash) {
        throw new Error(
          'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
          'during current-slot refresh',
        );
      }
    }

    await this.assertScopeCurrent(requestScope, 'current-slot refresh');

    let state = previous;
    let nextState: ContextGraphNameHashSlotState | undefined;
    if (rebuild || staged.length > 0) {
      const idsByHash = rebuild
        ? new Map<string, bigint[]>()
        : cloneIdsByHash(previous?.idsByHash);
      appendSlots(idsByHash, staged, firstId, latestId);
      nextState = {
        scope: copyScope(requestScope.scope),
        highWater: latestId,
        anchor: nextAnchor,
        idsByHash,
      };
      state = nextState;
    }

    const bindings = new Map<string, bigint | null>();
    for (const nameHash of normalizedNameHashes) {
      const ids = state?.idsByHash.get(nameHash) ?? [];
      if (ids.length > 1) {
        throw new Error(
          `resolveContextGraphIdByNameHash: ambiguous ${nameHash}; ` +
          `getNameHash commits it to ${ids.length} numeric ids`,
        );
      }
      bindings.set(nameHash, ids[0] ?? null);
    }

    const verification = await this.loadProviderHighWaters();
    this.assertCompleteProviderHighWaterBoundary(
      verification,
      'current-slot resolution',
    );
    if (verification.latestId !== latestId) {
      throw new Error(
        `resolveContextGraphIdByNameHash: Context Graph registry advanced from ` +
        `${latestId.toString()} to ${verification.latestId.toString()} ` +
        'during current-slot resolution',
      );
    }
    await this.verifyCurrentBindings(bindings, verification);
    if (normalizedNameHashes.length > 1) {
      const finalBoundary = await this.loadProviderHighWaters();
      this.assertCompleteProviderHighWaterBoundary(finalBoundary, 'current-slot resolution');
      if (finalBoundary.latestId !== latestId) {
        throw new Error('resolveContextGraphIdsByNameHashes: registry advanced during batch verification');
      }
      if ((await this.loadAnchorHash(nextAnchor.blockNumber))?.toLowerCase() !== nextAnchor.blockHash) {
        throw new Error(
          'resolveContextGraphIdsByNameHashes: canonical chain anchor changed during batch verification',
        );
      }
    }

    await this.assertScopeCurrent(requestScope, 'current-slot resolution');
    activeRpcRequestAbortSignal()?.throwIfAborted();
    if (nextState !== undefined) {
      this.currentSlotState = nextState;
      this.currentSlotGeneration += 1;
    }
    return { mode: 'current', bindings, highWater: latestId };
  }

  /** Verify only positive bindings, with at most four live slot reads. */
  private async verifyCurrentBindings(
    bindings: ReadonlyMap<string, bigint | null>,
    highWaterSnapshot?: ContextGraphNameHashProviderHighWaters,
  ): Promise<void> {
    const entries = [...bindings].filter((entry): entry is [string, bigint] => entry[1] !== null);
    const stop = new AbortController();
    let next = 0;
    await withRpcRequestContext({ signal: stop.signal }, async () => {
      const worker = async () => {
        for (;;) {
          activeRpcRequestAbortSignal()?.throwIfAborted();
          const entry = entries[next++];
          if (entry === undefined) return;
          const [nameHash, id] = entry;
          const currentHash = await this.readCurrentNameHash(id, undefined, highWaterSnapshot);
          activeRpcRequestAbortSignal()?.throwIfAborted();
          if (currentHash !== nameHash) {
            throw new Error(
              `resolveContextGraphIdByNameHash: indexed slot ${id.toString()} ` +
              `currently commits ${currentHash ?? ethers.ZeroHash}, expected ${nameHash}`,
            );
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(entries.length, 4) }, worker));
      } catch (error) {
        stop.abort(error);
        throw error;
      }
    });
  }

  /** Fixed-concurrency staged range loader for the bounded current lane. */
  private async loadSlots(
    firstId: bigint,
    lastId: bigint,
    highWaterSnapshot: ContextGraphNameHashProviderHighWaters,
  ): Promise<readonly ContextGraphNameHashSlot[]> {
    const scanController = new AbortController();
    const slots: ContextGraphNameHashSlot[] = [];
    let nextId = firstId;
    let failed = false;
    let firstFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        activeRpcRequestAbortSignal()?.throwIfAborted();
        const contextGraphId = nextId;
        if (contextGraphId > lastId) return;
        nextId += 1n;
        try {
          const currentHash = await this.readCurrentNameHash(
            contextGraphId,
            scanController.signal,
            highWaterSnapshot,
          );
          slots.push({ id: contextGraphId, nameHash: currentHash });
        } catch (cause) {
          if (!failed) {
            failed = true;
            firstFailure = cause;
            scanController.abort(cause);
          }
          return;
        }
      }
    };

    const workerCount = Math.min(
      CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
      Number(lastId - firstId + 1n),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) throw firstFailure;
    return slots;
  }

  async captureScope(): Promise<ContextGraphNameHashSlotScope> {
    const cgs = this.dependencies.requireContextGraphStorage();
    return {
      storageAddress: (await cgs.getAddress()).toLowerCase(),
      providers: [...this.dependencies.providers()],
      rpcUrls: [...this.dependencies.rpcUrls()],
    };
  }

  async captureScopeToken(): Promise<ContextGraphNameHashScopeToken> {
    return {
      epoch: this.bindingEpoch,
      scope: await this.captureScope(),
    };
  }

  async assertScopeCurrent(
    token: ContextGraphNameHashScopeToken,
    lane: 'current-slot refresh' | 'current-slot resolution' | 'historical scan',
  ): Promise<void> {
    const scopeAfter = await this.captureScope();
    if (this.bindingEpoch !== token.epoch || !sameScope(token.scope, scopeAfter)) {
      throw new Error(
        'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
        `binding changed during ${lane}`,
      );
    }
  }

  async captureAnchor(): Promise<ContextGraphNameHashSlotAnchor> {
    const block = await this.dependencies.readLatestBlock();
    if (block === null || block.hash === null) {
      throw new Error(
        'resolveContextGraphIdByNameHash: latest canonical block has no hash',
      );
    }
    return {
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
    };
  }

  loadAnchorHash(blockNumber: number): Promise<string | null> {
    return this.dependencies.readAnchorHash(blockNumber);
  }

  /** Read all reachable providers and retain the largest observed counter. */
  async loadProviderHighWaters(): Promise<ContextGraphNameHashProviderHighWaters> {
    await this.dependencies.initialize();
    const cgs = this.dependencies.requireContextGraphStorage();
    const providers = [...this.dependencies.providers()];
    const reads = await Promise.allSettled(providers.map((provider) =>
      this.loadProviderHighWater(cgs, provider, 'current')));
    const providerHighWaters = new Map(reads.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? [[providers[index]!, result.value] as const]
        : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const retryLater = failures.find(
      (failure) => classifyRpcRetryDisposition(failure.reason) === 'retry-later',
    );
    if (retryLater) throw retryLater.reason;
    const nonRetryableFailures = failures.filter(
      (failure) => !isContractViewRetryable(failure.reason),
    );
    if (nonRetryableFailures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${nonRetryableFailures.length} of ` +
        `${providers.length} RPC backends returned a non-retryable registry ` +
        'high-water failure',
        { cause: nonRetryableFailures[0]!.reason },
      );
    }
    if (providerHighWaters.size === 0) {
      throw failures[0]?.reason ?? new Error(
        'resolveContextGraphIdByNameHash: no RPC backend returned a current registry high-water',
      );
    }
    const latestId = [...providerHighWaters.values()].reduce(
      (maximum, value) => value > maximum ? value : maximum,
      0n,
    );
    return {
      latestId,
      providerHighWaters,
      unavailableProviderCount: failures.length,
    };
  }

  /**
   * A reverse lookup cannot return a positive or negative result while any
   * configured backend's registry boundary is unknown. Such a backend may
   * commit a higher numeric id (including a duplicate name hash) than every
   * responder. Incomplete snapshots may stage bounded slot reads, but only a
   * complete follow-up boundary may authorize a result or cache commit.
   */
  private assertCompleteProviderHighWaterBoundary(
    snapshot: ContextGraphNameHashProviderHighWaters,
    lane: 'current-slot resolution' | 'historical scan',
  ): void {
    if (snapshot.unavailableProviderCount === 0) return;
    const providerCount =
      snapshot.providerHighWaters.size + snapshot.unavailableProviderCount;
    throw new Error(
      `resolveContextGraphIdByNameHash: incomplete registry high-water ` +
      `coverage during ${lane}; ${snapshot.providerHighWaters.size} of ` +
      `${providerCount} RPC backends responded`,
    );
  }

  /**
   * Require a strict majority of providers at or above the slot to respond,
   * while every response agrees (including null). A transiently unavailable
   * backend is not conflicting chain evidence; a deterministic failure is.
   */
  async readCurrentNameHash(
    contextGraphId: bigint,
    signal?: AbortSignal,
    capturedHighWaterSnapshot?: ContextGraphNameHashProviderHighWaters,
  ): Promise<string | null> {
    await this.dependencies.initialize();
    const cgs = this.dependencies.requireContextGraphStorage();
    const highWaterSnapshot = capturedHighWaterSnapshot === undefined
      ? await this.loadProviderHighWaters()
      : capturedHighWaterSnapshot;
    const highWaters = highWaterSnapshot.providerHighWaters;
    const { unavailableProviderCount } = highWaterSnapshot;
    const coveringProviders = [...highWaters].filter(
      ([, highWater]) => highWater >= contextGraphId,
    );
    signal?.throwIfAborted();
    const reads = await Promise.allSettled(coveringProviders.map(([provider]) =>
      this.loadProviderNameHash(cgs, provider, contextGraphId, signal)));
    if (signal?.aborted) signal.throwIfAborted();

    const observed = new Set(reads.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const nonRetryableFailures = failures.filter(
      (failure) => !isContractViewRetryable(failure.reason),
    );
    if (nonRetryableFailures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${nonRetryableFailures.length} of ` +
        `${coveringProviders.length} covering RPC backends returned a non-retryable ` +
        `failure for current slot ${contextGraphId.toString()}`,
        { cause: nonRetryableFailures[0]!.reason },
      );
    }
    const fulfilledCount = reads.length - failures.length;
    const capturedCoveringProviderCount =
      coveringProviders.length + unavailableProviderCount;
    const requiredQuorum = Math.floor(capturedCoveringProviderCount / 2) + 1;
    if (fulfilledCount < requiredQuorum) {
      throw new Error(
        `resolveContextGraphIdByNameHash: insufficient covering RPC quorum for ` +
        `current slot ${contextGraphId.toString()}; ${fulfilledCount} of ` +
        `${capturedCoveringProviderCount} backends responded, need ${requiredQuorum}`,
        { cause: failures[0]?.reason },
      );
    }
    if (observed.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on current slot ` +
        contextGraphId.toString(),
      );
    }
    return observed.values().next().value ?? null;
  }

  /** Entire historical fence choreography, kept behind the chain source. */
  private async resolveHistorical(normalizedNameHash: string): Promise<bigint | null> {
    return (await this.resolveHistoricalMany([normalizedNameHash], normalizedNameHash)).get(normalizedNameHash)!;
  }

  private async resolveHistoricalMany(
    normalizedNameHashes: readonly string[],
    nameHashFilter: string | null,
  ): Promise<ReadonlyMap<string, bigint | null>> {
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const scopeToken = await this.captureScopeToken();
    const scan = await this.prepareHistoricalScan();
    const { fromBlock, head, pageSize } = scan;
    const pages = fromBlock > head
      ? 0
      : Math.ceil((head - fromBlock + 1) / pageSize);
    if (!Number.isSafeInteger(pages) || pages > CG_REGISTRY_MAX_SCAN_PAGES) {
      throw new Error(
        `resolveContextGraphIdByNameHash: historical ContextGraphCreated scan ` +
        `would need ${pages} eth_getLogs calls over blocks ` +
        `[${fromBlock}, ${head}] at a ${pageSize}-block window ` +
        `(budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages).`,
      );
    }

    const anchoredScan = await scan.anchor();
    const { headAnchor } = anchoredScan;
    const scannedRegistryHighWater = await this.loadHistoricalRegistryHighWaterAtHead(
      headAnchor.scanProviders.map(({ provider }) => provider),
      head,
    );
    const assertHistoricalRegistryCurrent = async (): Promise<void> => {
      const currentBoundary = await this.loadProviderHighWaters();
      this.assertCompleteProviderHighWaterBoundary(
        currentBoundary,
        'historical scan',
      );
      if (currentBoundary.latestId !== scannedRegistryHighWater) {
        throw new Error(
          `resolveContextGraphIdByNameHash: registry high-water changed from ` +
          `${scannedRegistryHighWater.toString()} to ` +
          `${currentBoundary.latestId.toString()} during historical scan`,
        );
      }
    };

    const usedProviders = new Set<JsonRpcProvider>([
      headAnchor.scanProviders[0]!.provider,
    ]);
    const assertScanCurrent = async (): Promise<void> => {
      activeRpcRequestAbortSignal()?.throwIfAborted();
      await this.assertScopeCurrent(scopeToken, 'historical scan');
      await this.assertHistoricalHeadCurrent(headAnchor, usedProviders);
    };

    const idsByHash = new Map(normalizedNameHashes.map((name) => [name, new Set<bigint>()]));
    let preferred: JsonRpcProvider | undefined;
    // Bulk reads one complete creation inventory. The page count is determined
    // by registry history, not by the number of hypothetical KA-path owners.
    // Single-name callers retain their existing exact-topic scan.
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      activeRpcRequestAbortSignal()?.throwIfAborted();
      const hi = Math.min(lo + pageSize - 1, head);
      const page = await anchoredScan.readContextGraphCreatedPage(nameHashFilter, lo, hi, preferred);
      activeRpcRequestAbortSignal()?.throwIfAborted();
      preferred = page.provider;
      usedProviders.add(page.provider);
      for (const { id, nameHash } of page.bindings) {
        if (id <= 0n || id > scannedRegistryHighWater || (nameHashFilter !== null && nameHash !== nameHashFilter)) {
          throw new Error(
            `resolveContextGraphIdByNameHash: invalid Context Graph id or name binding ${id.toString()} for ${nameHash}`,
          );
        }
        idsByHash.get(nameHash)?.add(id);
      }
    }

    await assertScanCurrent();
    const bindings = new Map<string, bigint | null>();
    for (const [nameHash, ids] of idsByHash) {
      if (ids.size > 1) {
        throw new Error(
          `resolveContextGraphIdByNameHash: ambiguous ${nameHash}; ` +
          `ContextGraphCreated committed it to ${ids.size} numeric ids`,
        );
      }
      bindings.set(nameHash, ids.values().next().value ?? null);
    }

    // Share provider coverage across positive verifications in a bulk request.
    const verification = normalizedNameHashes.length > 1 && [...bindings.values()].some((id) => id !== null)
      ? await this.loadProviderHighWaters()
      : undefined;
    if (verification !== undefined) {
      this.assertCompleteProviderHighWaterBoundary(verification, 'historical scan');
      if (verification.latestId !== scannedRegistryHighWater) {
        throw new Error('resolveContextGraphIdsByNameHashes: registry high-water changed during historical batch');
      }
    }
    await this.verifyCurrentBindings(bindings, verification);
    await assertScanCurrent();
    await assertHistoricalRegistryCurrent();
    await assertScanCurrent();
    return bindings;
  }

  /** Build one historical scan session scoped to the storage and creation event. */
  async prepareHistoricalScan(): Promise<ContextGraphNameHashHistoricalScan> {
    await this.dependencies.initialize();
    const contextGraphStorage = this.dependencies.requireContextGraphStorage();
    const storageAddress = (await contextGraphStorage.getAddress()).toLowerCase();
    const {
      fromBlock,
      head,
      scanProviders: reachableProviders,
    } = await this.dependencies.resolveContractDeployBlock(
      storageAddress,
      'resolveContextGraphIdByNameHash',
      'ContextGraphStorage',
    );
    return {
      fromBlock,
      head,
      pageSize: this.dependencies.scanPageSize(),
      anchor: async () => {
        const headAnchor = await this.captureHistoricalHead(reachableProviders, head);
        const connected = new Map<JsonRpcProvider, Contract>();
        return {
          headAnchor,
          readContextGraphCreatedPage: async (
            nameHashFilter,
            lo,
            hi,
            preferred,
          ) => {
            const filter = contextGraphStorage.filters.ContextGraphCreated(
              null,
              null,
              nameHashFilter,
            );
            const page = await this.dependencies.queryEventLogsPage(
              contextGraphStorage,
              filter,
              lo,
              hi,
              headAnchor.scanProviders,
              connected,
              'resolveContextGraphIdByNameHash ContextGraphCreated',
              preferred,
              'resolveContextGraphIdByNameHash',
            );
            const bindings: { id: bigint; nameHash: string }[] = [];
            for (const log of page.logs) {
              const parsed = contextGraphStorage.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
              });
              if (parsed?.name !== 'ContextGraphCreated' || !ethers.isHexString(parsed.args.nameHash, 32)) {
                throw new Error('resolveContextGraphIdsByNameHashes: invalid ContextGraphCreated log');
              }
              bindings.push({ id: BigInt(parsed.args.contextGraphId), nameHash: parsed.args.nameHash.toLowerCase() });
            }
            return { bindings, provider: page.provider };
          },
        };
      },
    };
  }

  /** Pin the registry counter to the same canonical block as a log scan. */
  async loadHistoricalRegistryHighWaterAtHead(
    providers: readonly JsonRpcProvider[],
    head: number,
  ): Promise<bigint> {
    const cgs = this.dependencies.requireContextGraphStorage();
    const reads = await Promise.allSettled(providers.map((provider) =>
      this.loadProviderHighWater(cgs, provider, 'historical', head)));
    const observedHighWaters = new Set(reads.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${failures.length} of ` +
        `${providers.length} RPC backends failed to read registry high-water ` +
        `at historical head ${head}`,
        { cause: failures[0]!.reason },
      );
    }
    if (observedHighWaters.size === 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: no RPC backend could read registry ` +
        `high-water at historical head ${head}`,
      );
    }
    if (observedHighWaters.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on registry ` +
        `high-water at historical head ${head}`,
      );
    }
    return observedHighWaters.values().next().value as bigint;
  }

  async captureHistoricalHead<T extends {
    readonly provider: JsonRpcProvider;
    readonly backendHead: number;
  }>(
    reachableProviders: readonly T[],
    head: number,
  ): Promise<ContextGraphNameHashHistoricalHeadAnchor<T>> {
    const headProviders = reachableProviders.filter(({ backendHead }) => backendHead >= head);
    let headHash: string | null = null;
    const observedHeadHashes = new Set<string>();
    const scanProviders: T[] = [];
    for (const candidate of headProviders) {
      try {
        const block = await withRpcRequestTimeout(
          CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash historical head anchor',
          () => candidate.provider.getBlock(head),
        );
        const candidateHash = block?.hash?.toLowerCase() ?? null;
        if (candidateHash === null) continue;
        observedHeadHashes.add(candidateHash);
        if (headHash === null) headHash = candidateHash;
        if (candidateHash === headHash) scanProviders.push(candidate);
      } catch (error) {
        if (classifyRpcRetryDisposition(error) === 'retry-later') throw error;
        // Keep collecting same-head providers; fail only when none can anchor.
      }
    }
    if (headHash === null || scanProviders.length === 0) {
      throw new Error(
        'resolveContextGraphIdByNameHash: no RPC backend could anchor the historical scan head',
      );
    }
    if (observedHeadHashes.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on canonical ` +
        `block hash at historical head ${head}`,
      );
    }
    return { head, headHash, scanProviders };
  }

  async assertHistoricalHeadCurrent(
    anchor: Pick<ContextGraphNameHashHistoricalHeadAnchor<unknown>, 'head' | 'headHash'>,
    usedProviders: ReadonlySet<JsonRpcProvider>,
  ): Promise<void> {
    for (const provider of usedProviders) {
      const block = await withRpcRequestTimeout(
        CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS,
        'resolveContextGraphIdByNameHash historical head revalidation',
        () => provider.getBlock(anchor.head),
      );
      if (block?.hash?.toLowerCase() !== anchor.headHash) {
        throw new Error(
          'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
          'during historical scan',
        );
      }
    }
  }

  private async loadProviderHighWater(
    contextGraphStorage: Contract,
    provider: JsonRpcProvider,
    lane: 'current' | 'historical',
    blockTag?: number,
  ): Promise<bigint> {
    await withRpcRequestTimeout(
      CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash ${lane} high-water chainId validation`,
      () => this.dependencies.ensureConfiguredStaticChainIdValidated(provider),
    );
    const connected = this.dependencies.rebindContract(contextGraphStorage, provider);
    const raw = await withRpcRequestTimeout(
      CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash ${lane} high-water read`,
      () => blockTag === undefined
        ? connected.getLatestContextGraphId()
        : connected.getLatestContextGraphId({ blockTag }),
    );
    const highWater = BigInt(raw);
    if (highWater < 0n) {
      throw new Error(
        `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
        `invalid negative id ${highWater.toString()}` +
        (blockTag === undefined ? '' : ` at historical head ${blockTag}`),
      );
    }
    return highWater;
  }

  private async loadProviderNameHash(
    contextGraphStorage: Contract,
    provider: JsonRpcProvider,
    contextGraphId: bigint,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const startRead = () => Promise.resolve(
      this.dependencies.rebindContract(
        contextGraphStorage,
        provider,
      ).getNameHash(contextGraphId) as Promise<string>,
    );
    const raw: string = await withRpcRequestTimeout(
      CONTEXT_GRAPH_NAME_HASH_GOVERNED_READ_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash current-slot getNameHash(${contextGraphId.toString()})`,
      () => {
        const physicalRead = signal
          ? withRpcRequestContext({ signal }, startRead)
          : startRead();
        return waitForContextGraphSlotRead(physicalRead, signal);
      },
    );
    return !raw || raw === ethers.ZeroHash ? null : raw.toLowerCase();
  }
}
