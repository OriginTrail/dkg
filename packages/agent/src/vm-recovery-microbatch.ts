/** Version-bound public-chain cost hints used only for VM recovery admission. */
export type VmRecoveryChainFootprint =
  | {
      readonly kind: 'public-v10';
      /** On-chain public N-Quads byte floor. Private payload bytes are excluded. */
      readonly byteSize: bigint;
      /** On-chain public post-canonicalization Merkle-leaf count. */
      readonly merkleLeafCount: bigint;
      /** Root/update version associated with this cost observation. */
      readonly assertionVersion: string;
      /**
       * Provenance of this soft scheduling hint.
       *
       * A pinned-finalized hint binds policy, root and sizing to one snapshot.
       * The classic reconciler can only obtain a latest-bounded scalar read;
       * it deliberately carries no synthetic block hash. Both remain hints:
       * exact executor caps and post-fetch chain reconciliation are the
       * correctness boundary.
       */
      readonly anchor:
        | {
            readonly kind: 'pinned-finalized';
            readonly blockHash: string;
          }
        | { readonly kind: 'latest-bounded' };
    }
  | { readonly kind: 'unknown' };

export interface VmRecoveryFootprintBridgeTarget {
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

export interface VmRecoveryFootprintBridgeReader {
  isContextGraphActiveOnChain?(contextGraphId: bigint): Promise<boolean>;
  getContextGraphAccessPolicy?(contextGraphId: bigint): Promise<number>;
  getKnowledgeAssetUpdateContext?(
    kaId: bigint,
    options?: { signal?: AbortSignal },
  ): Promise<{
    merkleRootsCount: bigint;
    byteSize: bigint;
    merkleLeafCount: number;
  }>;
}

export interface VmRecoveryFootprintBridgeOptions {
  /** Hard upper bound on per-slice update-context reads. */
  maxContextReads: number;
  /** Per-KA wall-clock ceiling for optional latest-state sizing reads. */
  sizingReadTimeoutMs?: number;
  signal?: AbortSignal;
  /** Captured subscription/binding lifecycle guard. */
  isCurrent: () => boolean;
  /**
   * Optional host trust anchor for bounded, live-gated access-policy reads.
   * Production supplies DKGAgent.readLiveOnChainAccessPolicy; direct helper
   * tests and non-agent consumers may exercise the equivalent reader surface.
   */
  resolveLiveAccessPolicy?: (contextGraphId: bigint) => Promise<0 | 1 | null>;
}

const VM_RECOVERY_BRIDGE_ABORTED = Symbol('vm-recovery-bridge-aborted');
const VM_RECOVERY_BRIDGE_TIMED_OUT = Symbol('vm-recovery-bridge-timed-out');
export const VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS = 2_500;

async function raceVmRecoveryBridgeAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof VM_RECOVERY_BRIDGE_ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return VM_RECOVERY_BRIDGE_ABORTED;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<typeof VM_RECOVERY_BRIDGE_ABORTED>((resolve) => {
    abortListener = () => resolve(VM_RECOVERY_BRIDGE_ABORTED);
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

async function readVmRecoveryFootprintWithDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<
  T
  | typeof VM_RECOVERY_BRIDGE_ABORTED
  | typeof VM_RECOVERY_BRIDGE_TIMED_OUT
> {
  if (callerSignal?.aborted) return VM_RECOVERY_BRIDGE_ABORTED;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortFromCaller: (() => void) | undefined;
  let callerDidAbort = false;
  let deadlineExpired = false;
  const callerAborted = new Promise<typeof VM_RECOVERY_BRIDGE_ABORTED>((resolve) => {
    if (!callerSignal) return;
    abortFromCaller = () => {
      callerDidAbort = true;
      resolve(VM_RECOVERY_BRIDGE_ABORTED);
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  });
  const timedOut = new Promise<typeof VM_RECOVERY_BRIDGE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // Make the deadline outcome authoritative before cancellation. Some
      // signal-aware adapters synchronously settle their work from an abort
      // handler; that late value must never beat the already-expired deadline.
      deadlineExpired = true;
      resolve(VM_RECOVERY_BRIDGE_TIMED_OUT);
      controller.abort(new Error(
        `VM recovery footprint read timed out after ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  let work: Promise<T>;
  try {
    // Invoke immediately so a synchronous lifecycle abort prevents later
    // reads in the same bounded prefix from even starting.
    work = Promise.resolve(start(controller.signal));
  } catch (error) {
    work = Promise.reject(error);
  }
  try {
    const result = await Promise.race([work, callerAborted, timedOut]);
    if (callerDidAbort) return VM_RECOVERY_BRIDGE_ABORTED;
    if (deadlineExpired) return VM_RECOVERY_BRIDGE_TIMED_OUT;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal && abortFromCaller) {
      callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
}

function downgradeUnverifiedPublicFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
): T[] {
  return targets.map((target) => target.recoveryFootprint?.kind === 'public-v10'
    ? { ...target, recoveryFootprint: { kind: 'unknown' } }
    : target) as T[];
}

/**
 * Enrich a bounded prefix of classic-reconciler targets with public-chain
 * sizing hints.
 *
 * This is intentionally weaker than the pinned finalized inventory scanner:
 * the access-policy and update-context calls are latest-state reads and are
 * not root-atomic. Consequently they get an explicit `latest-bounded` anchor
 * and can only influence soft packing. Positive CG liveness is required before
 * consulting the default-zero policy getter or trusting an existing public
 * hint. Any absent authority capability, inactive or non-public policy, abort,
 * or stale lifecycle downgrades public hints to unknown. Once public authority
 * is proven, failed/zero/deadline-limited scalar reads leave only their target
 * unknown so it retains the legacy singleton request shape.
 */
export async function enrichVmRecoveryFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
  onChainCgId: bigint,
  reader: VmRecoveryFootprintBridgeReader,
  options: Readonly<VmRecoveryFootprintBridgeOptions>,
): Promise<T[]> {
  const original = [...targets];
  const unverified = downgradeUnverifiedPublicFootprints(targets);
  if (targets.length === 0) return original;
  if (
    onChainCgId <= 0n
    || options.signal?.aborted
    || !options.isCurrent()
  ) return unverified;

  let accessPolicy: number | null;
  if (options.resolveLiveAccessPolicy) {
    try {
      const resolved = await raceVmRecoveryBridgeAbort(
        options.resolveLiveAccessPolicy(onChainCgId),
        options.signal,
      );
      if (resolved === VM_RECOVERY_BRIDGE_ABORTED) return unverified;
      accessPolicy = resolved;
    } catch {
      return unverified;
    }
  } else {
    if (
      typeof reader.isContextGraphActiveOnChain !== 'function'
      || typeof reader.getContextGraphAccessPolicy !== 'function'
    ) return unverified;
    let active: boolean | typeof VM_RECOVERY_BRIDGE_ABORTED;
    try {
      active = await raceVmRecoveryBridgeAbort(
        reader.isContextGraphActiveOnChain(onChainCgId),
        options.signal,
      );
    } catch {
      return unverified;
    }
    if (
      active !== true
      || options.signal?.aborted
      || !options.isCurrent()
    ) return unverified;
    try {
      const resolved = await raceVmRecoveryBridgeAbort(
        reader.getContextGraphAccessPolicy(onChainCgId),
        options.signal,
      );
      if (resolved === VM_RECOVERY_BRIDGE_ABORTED) return unverified;
      accessPolicy = resolved;
    } catch {
      return unverified;
    }
  }
  if (accessPolicy !== 0 || options.signal?.aborted || !options.isCurrent()) {
    return unverified;
  }

  const unknownEntries = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.recoveryFootprint
      || target.recoveryFootprint.kind === 'unknown')
    .slice(0, options.maxContextReads);
  if (unknownEntries.length === 0) return original;
  const sizingReadTimeoutMs = options.sizingReadTimeoutMs
    ?? VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(options.maxContextReads)
    || options.maxContextReads <= 0
    || !Number.isSafeInteger(sizingReadTimeoutMs)
    || sizingReadTimeoutMs <= 0
    || typeof reader.getKnowledgeAssetUpdateContext !== 'function'
  ) return original;

  const observed = await Promise.all(unknownEntries.map(async ({ target, index }) => {
    if (options.signal?.aborted || !options.isCurrent()) return { index };
    try {
      const observedContext = await readVmRecoveryFootprintWithDeadline(
        (signal) => reader.getKnowledgeAssetUpdateContext!(
          BigInt(target.kaId), { signal },
        ),
        options.signal,
        sizingReadTimeoutMs,
      );
      if (
        observedContext === VM_RECOVERY_BRIDGE_ABORTED
        || observedContext === VM_RECOVERY_BRIDGE_TIMED_OUT
      ) return { index };
      const context = observedContext;
      if (
        options.signal?.aborted
        || !options.isCurrent()
        || context.merkleRootsCount <= 0n
        || context.byteSize <= 0n
        || !Number.isSafeInteger(context.merkleLeafCount)
        || context.merkleLeafCount <= 0
      ) return { index };
      return {
        index,
        footprint: {
          kind: 'public-v10',
          byteSize: context.byteSize,
          merkleLeafCount: BigInt(context.merkleLeafCount),
          assertionVersion: context.merkleRootsCount.toString(),
          anchor: { kind: 'latest-bounded' },
        } satisfies VmRecoveryChainFootprint,
      };
    } catch {
      return { index };
    }
  }));

  // An unsubscribe/rebind/abort invalidates the whole latest-state observation
  // instead of leaking a partially enriched scheduling plan across lifecycles.
  if (options.signal?.aborted || !options.isCurrent()) return unverified;
  const enriched = [...targets];
  for (const { index, footprint } of observed) {
    if (!footprint) continue;
    enriched[index] = { ...targets[index]!, recoveryFootprint: footprint };
  }
  return enriched;
}

export interface VmRecoveryTargetFootprint {
  readonly recoveryFootprint: VmRecoveryChainFootprint;
}

export interface VmRecoveryMicrobatchLimits {
  /** Hard asset-count capability supplied by the concrete executor. */
  maxAssets: number;
  /** Soft byte target for one exact-recovery request. */
  targetBytes: bigint;
  /** Soft Merkle-leaf/page-fairness target for one exact-recovery request. */
  targetLeaves: bigint;
  /** Fixed retained/metadata overhead charged for each asset. */
  fixedBytesPerAsset: bigint;
  /** Conservative retained/serialization overhead charged per public leaf. */
  bytesPerLeafOverhead: bigint;
  /** Basis-point multiplier applied to the on-chain public byte floor. */
  byteSizeMultiplierBps: bigint;
  /** Hard encoded-selector budget of the concrete executor. */
  maxSelectorBytes: number;
}

export interface VmRecoveryMicrobatchPlan<T> {
  readonly targets: readonly T[];
  readonly estimatedBytes: bigint;
  readonly estimatedLeaves: bigint;
  readonly selectorBytes: number;
  readonly completeFootprints: boolean;
}

export type VmRecoveryUalDisposition = 'found' | 'clean-absent' | 'incomplete';

interface VmRecoveryPeerState {
  used: boolean;
  unavailable: boolean;
  provenHolder: boolean;
  readonly ualDispositions: Map<string, VmRecoveryUalDisposition>;
}

/**
 * One recovery slice's provider-affinity state machine.
 *
 * Mutable transport facts stay encapsulated here instead of leaking as sets
 * across the orchestration loop. A holder hint is earned only by a complete
 * exact response and is revoked by any partial/incomplete or absent batch.
 * Per-UAL dispositions remain inspectable for deterministic tests/telemetry.
 */
export class VmRecoveryProviderPolicy {
  readonly #peers = new Map<string, VmRecoveryPeerState>();
  readonly #consideredPeerIds = new Set<string>();

  #state(peerId: string): VmRecoveryPeerState {
    let state = this.#peers.get(peerId);
    if (!state) {
      state = {
        used: false,
        unavailable: false,
        provenHolder: false,
        ualDispositions: new Map(),
      };
      this.#peers.set(peerId, state);
    }
    return state;
  }

  isProvenHolder(peerId: string): boolean {
    return this.#peers.get(peerId)?.provenHolder === true;
  }

  canAttempt(peerId: string): boolean {
    const state = this.#peers.get(peerId);
    return state?.unavailable !== true && (state?.used !== true || state.provenHolder);
  }

  tryConsider(peerId: string, maxPeers: number): boolean {
    if (this.#consideredPeerIds.has(peerId)) return true;
    if (this.#consideredPeerIds.size >= maxPeers) return false;
    this.#consideredPeerIds.add(peerId);
    return true;
  }

  recordAttempt(peerId: string): void {
    this.#state(peerId).used = true;
  }

  recordUnavailable(peerId: string): void {
    const state = this.#state(peerId);
    state.unavailable = true;
    state.provenHolder = false;
  }

  recordBatch(
    peerId: string,
    aggregateDisposition: VmRecoveryUalDisposition,
    perUalDispositions: ReadonlyMap<string, VmRecoveryUalDisposition>,
  ): void {
    const state = this.#state(peerId);
    for (const [ual, disposition] of perUalDispositions) {
      state.ualDispositions.set(ual, disposition);
    }
    state.provenHolder = aggregateDisposition === 'found'
      && perUalDispositions.size > 0
      && [...perUalDispositions.values()].every((disposition) => disposition === 'found');
  }

  ualDisposition(peerId: string, ual: string): VmRecoveryUalDisposition | undefined {
    return this.#peers.get(peerId)?.ualDispositions.get(ual);
  }

  unavailablePeerIds(): ReadonlySet<string> {
    return new Set(
      [...this.#peers]
        .filter(([, state]) => state.unavailable)
        .map(([peerId]) => peerId),
    );
  }
}

function nonNegativeFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function nonNegativeBigint(value: unknown): bigint | undefined {
  return typeof value === 'bigint' && value >= 0n ? value : undefined;
}

/**
 * Pack a stable prefix for one exact-recovery request.
 *
 * A target with neither chain cost hint is deliberately isolated. When one
 * dimension is unavailable the known dimension still controls packing, while
 * the caller-supplied executor capability remains the hard resource guard.
 * The first target is always admitted, even when it exceeds a soft byte or
 * leaf/page-fairness budget, so an individually-large KA cannot deadlock the
 * recovery queue.
 *
 * This planner is transport-neutral: the existing exact-sync executor supplies
 * its ten-asset and selector-byte caps; a future streaming executor can supply
 * a larger window without changing inventory/provider orchestration.
 */
export function planVmRecoveryMicrobatch<T extends VmRecoveryTargetFootprint>(
  candidates: readonly T[],
  limits: Readonly<VmRecoveryMicrobatchLimits>,
  selectorBytesFor: (targets: readonly T[]) => number,
): VmRecoveryMicrobatchPlan<T> {
  if (
    !Number.isSafeInteger(limits.maxAssets)
    || limits.maxAssets <= 0
    || limits.targetBytes < 0n
    || limits.targetLeaves < 0n
    || limits.fixedBytesPerAsset < 0n
    || limits.bytesPerLeafOverhead < 0n
    || limits.byteSizeMultiplierBps < 10_000n
    || !Number.isSafeInteger(limits.maxSelectorBytes)
    || limits.maxSelectorBytes <= 0
  ) {
    throw new Error('Invalid VM recovery microbatch limits');
  }
  const targets: T[] = [];
  let estimatedBytes = 0n;
  let estimatedLeaves = 0n;
  let selectorBytes = 0;
  let completeFootprints = true;

  for (const candidate of candidates) {
    if (targets.length >= limits.maxAssets) break;
    const footprint = candidate.recoveryFootprint;
    const byteSize = footprint.kind === 'public-v10'
      ? nonNegativeBigint(footprint.byteSize)
      : undefined;
    const merkleLeafCount = footprint.kind === 'public-v10'
      ? nonNegativeBigint(footprint.merkleLeafCount)
      : undefined;
    const footprintComplete = byteSize !== undefined && merkleLeafCount !== undefined;
    const candidateTargets = [...targets, candidate];
    const nextSelectorBytes = nonNegativeFiniteInteger(selectorBytesFor(candidateTargets));
    // Selector size is an executor hard cap, not a soft packing target. Even
    // the first candidate must be rejected when its exact encoded request
    // cannot fit; admitting it would only defer a deterministic wire failure.
    if (nextSelectorBytes === undefined || nextSelectorBytes > limits.maxSelectorBytes) break;

    // Both public-chain dimensions are required. A private/catalog footprint,
    // an older adapter, or an unversioned partial read stays in the legacy
    // one-KA request shape rather than silently underestimating transfer cost.
    if (
      byteSize === undefined
      || merkleLeafCount === undefined
      || byteSize === 0n
      || merkleLeafCount === 0n
    ) {
      if (targets.length === 0) {
        targets.push(candidate);
        selectorBytes = nextSelectorBytes;
        completeFootprints = footprintComplete;
      }
      break;
    }

    const scaledByteFloor = (
      byteSize * limits.byteSizeMultiplierBps + 9_999n
    ) / 10_000n;
    const graphAndLeafFloor = byteSize
      + merkleLeafCount * limits.bytesPerLeafOverhead;
    const candidateEstimatedBytes = (
      scaledByteFloor > graphAndLeafFloor ? scaledByteFloor : graphAndLeafFloor
    ) + limits.fixedBytesPerAsset;
    const nextBytes = estimatedBytes + candidateEstimatedBytes;
    const nextLeaves = estimatedLeaves + merkleLeafCount;
    const exceedsKnownBudget = (
      nextBytes > limits.targetBytes
      || nextLeaves > limits.targetLeaves
    );
    if (targets.length > 0 && exceedsKnownBudget) break;

    targets.push(candidate);
    estimatedBytes = nextBytes;
    estimatedLeaves = nextLeaves;
    selectorBytes = nextSelectorBytes;
    completeFootprints &&= footprintComplete;
  }

  return {
    targets,
    estimatedBytes,
    estimatedLeaves,
    selectorBytes,
    completeFootprints,
  };
}
