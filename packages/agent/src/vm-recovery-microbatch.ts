/** Version-bound public-chain cost hints used only for VM recovery admission. */
export type VmRecoveryChainFootprint =
  | {
      readonly kind: 'public-v10';
      /** On-chain public N-Quads byte floor. Private payload bytes are excluded. */
      readonly byteSize: bigint;
      /** On-chain public post-canonicalization Merkle-leaf count. */
      readonly merkleLeafCount: bigint;
      /** Root/update version read in the same finalized snapshot. */
      readonly assertionVersion: string;
      /** Finalized anchor binding the policy, root, and sizing tuple. */
      readonly finalizedBlockHash: string;
    }
  | { readonly kind: 'unknown' };

export interface VmRecoveryTargetFootprint {
  readonly recoveryFootprint: VmRecoveryChainFootprint;
}

export interface VmRecoveryMicrobatchLimits {
  /** Hard asset-count capability supplied by the concrete executor. */
  maxAssets: number;
  /** Soft byte target for one exact-recovery request. */
  targetBytes: bigint;
  /** Soft Merkle-leaf target for one exact-recovery request. */
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
 * The first target is always admitted, even when it exceeds a soft budget, so
 * an individually-large KA cannot deadlock the recovery queue.
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
