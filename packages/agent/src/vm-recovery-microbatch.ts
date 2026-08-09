import type { KnowledgeAssetUpdateContext } from '@origintrail-official/dkg-chain';

import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';

export interface VmRecoveryFootprintBridgeTarget {
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

/** Canonical chain fields consumed by the classic VM recovery sizing bridge. */
export type VmRecoveryUpdateContext = Pick<
  KnowledgeAssetUpdateContext,
  'merkleRootsCount' | 'byteSize' | 'merkleLeafCount'
>;

export interface VmRecoveryFootprintSizingReader {
  readUpdateContext(
    kaId: bigint,
    options?: { signal?: AbortSignal },
  ): Promise<VmRecoveryUpdateContext>;
}

export type VmRecoveryFootprintAuthority =
  | {
      readonly kind: 'host-policy';
      resolveAccessPolicy(contextGraphId: bigint): Promise<0 | 1 | null>;
    }
  | {
      readonly kind: 'chain-reader';
      isContextGraphActive(contextGraphId: bigint): Promise<boolean>;
      readAccessPolicy(contextGraphId: bigint): Promise<number>;
    };

/**
 * Explicit bridge mode: authority is always present, while unavailable sizing
 * is represented deliberately with `null` rather than capability probing.
 */
export interface VmRecoveryFootprintBridge {
  readonly authority: VmRecoveryFootprintAuthority;
  readonly sizing: VmRecoveryFootprintSizingReader | null;
}

export interface VmRecoveryFootprintBridgeOptions {
  /** Hard upper bound on per-slice update-context reads. */
  maxContextReads: number;
  /** Per-KA wall-clock ceiling for optional latest-state sizing reads. */
  sizingReadTimeoutMs?: number;
  signal?: AbortSignal;
  /** Captured subscription/binding lifecycle guard. */
  isCurrent: () => boolean;
}

const VM_RECOVERY_BRIDGE_ABORTED = Symbol('vm-recovery-bridge-aborted');
const VM_RECOVERY_BRIDGE_TIMED_OUT = Symbol('vm-recovery-bridge-timed-out');
export const VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS = 2_500;

function vmRecoveryBridgeSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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

export type VmRecoveryFootprintEnrichedTarget<
  T extends VmRecoveryFootprintBridgeTarget,
> = T & { readonly recoveryFootprint?: VmRecoveryChainFootprint };

function downgradeUnverifiedPublicFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
): VmRecoveryFootprintEnrichedTarget<T>[] {
  return targets.map((target): VmRecoveryFootprintEnrichedTarget<T> =>
    target.recoveryFootprint?.kind === 'public-v10'
      ? { ...target, recoveryFootprint: { kind: 'unknown' } }
      : target);
}

async function resolveVmRecoveryPublicAuthority(
  onChainCgId: bigint,
  authority: VmRecoveryFootprintAuthority,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    if (authority.kind === 'host-policy') {
      const policy = await raceVmRecoveryBridgeAbort(
        authority.resolveAccessPolicy(onChainCgId),
        signal,
      );
      return policy !== VM_RECOVERY_BRIDGE_ABORTED
        && policy === 0
        && !vmRecoveryBridgeSignalAborted(signal)
        && isCurrent();
    }
    const active = await raceVmRecoveryBridgeAbort(
      authority.isContextGraphActive(onChainCgId),
      signal,
    );
    if (active !== true || vmRecoveryBridgeSignalAborted(signal) || !isCurrent()) return false;
    const policy = await raceVmRecoveryBridgeAbort(
      authority.readAccessPolicy(onChainCgId),
      signal,
    );
    return policy !== VM_RECOVERY_BRIDGE_ABORTED
      && policy === 0
      && !vmRecoveryBridgeSignalAborted(signal)
      && isCurrent();
  } catch {
    return false;
  }
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
 * hint. An inactive, non-public, unavailable, aborted, or stale authority
 * observation downgrades public hints to unknown. Once public authority is
 * proven, unavailable sizing and failed/zero/deadline-limited scalar reads
 * leave their target on the legacy singleton request shape.
 */
export async function enrichVmRecoveryFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
  onChainCgId: bigint,
  bridge: VmRecoveryFootprintBridge,
  options: Readonly<VmRecoveryFootprintBridgeOptions>,
): Promise<VmRecoveryFootprintEnrichedTarget<T>[]> {
  const original: VmRecoveryFootprintEnrichedTarget<T>[] = [...targets];
  const unverified = downgradeUnverifiedPublicFootprints(targets);
  if (targets.length === 0) return original;
  if (
    onChainCgId <= 0n
    || options.signal?.aborted
    || !options.isCurrent()
  ) return unverified;

  const publicAuthority = await resolveVmRecoveryPublicAuthority(
    onChainCgId,
    bridge.authority,
    options.signal,
    options.isCurrent,
  );
  if (!publicAuthority || options.signal?.aborted || !options.isCurrent()) {
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
    || bridge.sizing === null
  ) return original;

  const sizing = bridge.sizing;

  const observed = await Promise.all(unknownEntries.map(async ({ target, index }) => {
    if (options.signal?.aborted || !options.isCurrent()) return { index };
    try {
      const observedContext = await readVmRecoveryFootprintWithDeadline(
        (signal) => sizing.readUpdateContext(
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
  const enriched: VmRecoveryFootprintEnrichedTarget<T>[] = [...targets];
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
  provenHolderReuseSpent: boolean;
  activeAttempt: VmRecoveryProviderAttempt | null;
  readonly ualDispositions: Map<string, VmRecoveryUalDisposition>;
}

export type VmRecoveryProviderAttemptKind = 'probe' | 'proven-holder-reuse';

export interface VmRecoveryProviderAttempt {
  readonly peerId: string;
  readonly kind: VmRecoveryProviderAttemptKind;
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
        provenHolderReuseSpent: false,
        activeAttempt: null,
        ualDispositions: new Map(),
      };
      this.#peers.set(peerId, state);
    }
    return state;
  }

  #isProvenHolder(peerId: string): boolean {
    const state = this.#peers.get(peerId);
    return state?.provenHolder === true && !state.provenHolderReuseSpent;
  }

  #canAttempt(peerId: string): boolean {
    const state = this.#peers.get(peerId);
    return state?.unavailable !== true
      && state?.activeAttempt == null
      && (state?.used !== true || (state.provenHolder && !state.provenHolderReuseSpent));
  }

  selectNextCandidate(
    candidatePeerIds: readonly string[],
    maxPeers: number,
  ): string | undefined {
    const ordered = [
      ...candidatePeerIds.filter((peerId) => this.#isProvenHolder(peerId)),
      ...candidatePeerIds.filter((peerId) => !this.#isProvenHolder(peerId)),
    ];
    for (const peerId of ordered) {
      if (!this.#canAttempt(peerId)) continue;
      if (!this.#consideredPeerIds.has(peerId)) {
        if (this.#consideredPeerIds.size >= maxPeers) return undefined;
        this.#consideredPeerIds.add(peerId);
      }
      return peerId;
    }
    return undefined;
  }

  markUnavailable(peerId: string): void {
    const state = this.#state(peerId);
    state.unavailable = true;
    state.provenHolder = false;
    state.activeAttempt = null;
  }

  /**
   * Atomically begin either a first probe or the one holder-affinity reuse
   * available in this recovery slice. The reuse lease is spent here, before
   * transport dispatch, so completion cannot accidentally re-arm it.
   */
  beginAttempt(peerId: string): VmRecoveryProviderAttempt | undefined {
    const state = this.#state(peerId);
    if (!this.#canAttempt(peerId)) return undefined;
    const kind: VmRecoveryProviderAttemptKind = state.used
      ? 'proven-holder-reuse'
      : 'probe';
    state.used = true;
    const attempt = { peerId, kind } satisfies VmRecoveryProviderAttempt;
    state.activeAttempt = attempt;
    if (kind === 'proven-holder-reuse') state.provenHolderReuseSpent = true;
    return attempt;
  }

  finishAttempt(
    attempt: VmRecoveryProviderAttempt,
    aggregateDisposition: VmRecoveryUalDisposition,
    perUalDispositions: ReadonlyMap<string, VmRecoveryUalDisposition>,
  ): void {
    const state = this.#state(attempt.peerId);
    if (state.activeAttempt !== attempt) {
      throw new Error(`VM recovery provider attempt is not active for ${attempt.peerId}`);
    }
    state.activeAttempt = null;
    for (const [ual, disposition] of perUalDispositions) {
      state.ualDispositions.set(ual, disposition);
    }
    state.provenHolder = !state.provenHolderReuseSpent
      && aggregateDisposition === 'found'
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
