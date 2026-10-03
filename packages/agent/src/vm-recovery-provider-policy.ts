export type VmRecoveryUalDisposition = 'found' | 'clean-absent' | 'incomplete';
export type VmRecoveryProviderAttemptKind = 'probe' | 'proven-holder-reuse';

export interface VmRecoveryProviderAttempt {
  readonly peerId: string;
  readonly kind: VmRecoveryProviderAttemptKind;
}

type VmRecoveryProviderPhase =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'attempting-probe'; readonly attempt: VmRecoveryProviderAttempt }
  | { readonly kind: 'holder-reusable' }
  | { readonly kind: 'attempting-reuse'; readonly attempt: VmRecoveryProviderAttempt }
  | { readonly kind: 'spent' }
  | { readonly kind: 'unavailable' };

interface VmRecoveryPeerState {
  phase: VmRecoveryProviderPhase;
}

const NO_DEFERRED_PEERS: ReadonlySet<string> = new Set();

/** One recovery slice's explicit provider-affinity state machine. */
export class VmRecoveryProviderPolicy {
  readonly #peers = new Map<string, VmRecoveryPeerState>();
  readonly #consideredPeerIds = new Set<string>();

  #state(peerId: string): VmRecoveryPeerState {
    let state = this.#peers.get(peerId);
    if (!state) {
      state = { phase: { kind: 'fresh' } };
      this.#peers.set(peerId, state);
    }
    return state;
  }

  #canAttempt(peerId: string): boolean {
    const kind = this.#peers.get(peerId)?.phase.kind ?? 'fresh';
    return kind === 'fresh' || kind === 'holder-reusable';
  }

  /**
   * `deferredPeerIds` names candidates that cannot be attempted yet. They are
   * passed over, and each keeps a place among the peers this slice may
   * consider, so the peers tried meanwhile cannot crowd it out of the slice.
   */
  selectNextCandidate(
    candidatePeerIds: readonly string[],
    maxPeers: number,
    deferredPeerIds: ReadonlySet<string> = NO_DEFERRED_PEERS,
  ): string | undefined {
    for (const peerId of candidatePeerIds) {
      if (deferredPeerIds.has(peerId) && !this.#consideredPeerIds.has(peerId)
        && this.#consideredPeerIds.size < maxPeers) {
        this.#consideredPeerIds.add(peerId);
      }
    }
    const attemptablePeerIds = candidatePeerIds.filter((peerId) => !deferredPeerIds.has(peerId));
    const ordered = [
      ...attemptablePeerIds.filter((peerId) => this.#peers.get(peerId)?.phase.kind === 'holder-reusable'),
      ...attemptablePeerIds.filter((peerId) => this.#peers.get(peerId)?.phase.kind !== 'holder-reusable'),
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
    this.#state(peerId).phase = { kind: 'unavailable' };
  }

  /** The host must prove a current carried holder; one reuse still spends it. */
  seedProvenHolder(peerId: string): void {
    const state = this.#state(peerId);
    if (state.phase.kind === 'fresh') state.phase = { kind: 'holder-reusable' };
  }

  beginAttempt(peerId: string): VmRecoveryProviderAttempt | undefined {
    const state = this.#state(peerId);
    if (!this.#canAttempt(peerId)) return undefined;
    const kind: VmRecoveryProviderAttemptKind = state.phase.kind === 'holder-reusable'
      ? 'proven-holder-reuse'
      : 'probe';
    const attempt = { peerId, kind } satisfies VmRecoveryProviderAttempt;
    state.phase = kind === 'probe'
      ? { kind: 'attempting-probe', attempt }
      : { kind: 'attempting-reuse', attempt };
    return attempt;
  }

  #activeState(attempt: VmRecoveryProviderAttempt): VmRecoveryPeerState {
    const state = this.#state(attempt.peerId);
    const activeAttempt = state.phase.kind === 'attempting-probe'
      || state.phase.kind === 'attempting-reuse'
      ? state.phase.attempt
      : undefined;
    if (activeAttempt !== attempt) {
      throw new Error(`VM recovery provider attempt is not active for ${attempt.peerId}`);
    }
    return state;
  }

  finishAttempt(
    attempt: VmRecoveryProviderAttempt,
    aggregateDisposition: VmRecoveryUalDisposition,
    perUalDispositions: ReadonlyMap<string, VmRecoveryUalDisposition>,
  ): void {
    const state = this.#activeState(attempt);
    const earnedReuse = state.phase.kind === 'attempting-probe'
      && aggregateDisposition === 'found'
      && perUalDispositions.size > 0
      && [...perUalDispositions.values()].every((disposition) => disposition === 'found');
    state.phase = earnedReuse ? { kind: 'holder-reusable' } : { kind: 'spent' };
  }

  /**
   * The attempt ended without a verdict on the peer's data. The peer may be
   * attempted again in this slice, and has to earn reuse again with a probe.
   */
  releaseAttempt(attempt: VmRecoveryProviderAttempt): void {
    this.#activeState(attempt).phase = { kind: 'fresh' };
  }

  unavailablePeerIds(): ReadonlySet<string> {
    return new Set([...this.#peers]
      .filter(([, state]) => state.phase.kind === 'unavailable')
      .map(([peerId]) => peerId));
  }
}
