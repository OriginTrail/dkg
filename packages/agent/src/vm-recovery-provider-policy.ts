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
  readonly ualDispositions: Map<string, VmRecoveryUalDisposition>;
}

/** One recovery slice's explicit provider-affinity state machine. */
export class VmRecoveryProviderPolicy {
  readonly #peers = new Map<string, VmRecoveryPeerState>();
  readonly #consideredPeerIds = new Set<string>();

  #state(peerId: string): VmRecoveryPeerState {
    let state = this.#peers.get(peerId);
    if (!state) {
      state = { phase: { kind: 'fresh' }, ualDispositions: new Map() };
      this.#peers.set(peerId, state);
    }
    return state;
  }

  #canAttempt(peerId: string): boolean {
    const kind = this.#peers.get(peerId)?.phase.kind ?? 'fresh';
    return kind === 'fresh' || kind === 'holder-reusable';
  }

  selectNextCandidate(candidatePeerIds: readonly string[], maxPeers: number): string | undefined {
    const ordered = [
      ...candidatePeerIds.filter((peerId) => this.#peers.get(peerId)?.phase.kind === 'holder-reusable'),
      ...candidatePeerIds.filter((peerId) => this.#peers.get(peerId)?.phase.kind !== 'holder-reusable'),
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

  finishAttempt(
    attempt: VmRecoveryProviderAttempt,
    aggregateDisposition: VmRecoveryUalDisposition,
    perUalDispositions: ReadonlyMap<string, VmRecoveryUalDisposition>,
  ): void {
    const state = this.#state(attempt.peerId);
    const activeAttempt = state.phase.kind === 'attempting-probe'
      || state.phase.kind === 'attempting-reuse'
      ? state.phase.attempt
      : undefined;
    if (activeAttempt !== attempt) {
      throw new Error(`VM recovery provider attempt is not active for ${attempt.peerId}`);
    }
    for (const [ual, disposition] of perUalDispositions) {
      state.ualDispositions.set(ual, disposition);
    }
    const earnedReuse = state.phase.kind === 'attempting-probe'
      && aggregateDisposition === 'found'
      && perUalDispositions.size > 0
      && [...perUalDispositions.values()].every((disposition) => disposition === 'found');
    state.phase = earnedReuse ? { kind: 'holder-reusable' } : { kind: 'spent' };
  }

  ualDisposition(peerId: string, ual: string): VmRecoveryUalDisposition | undefined {
    return this.#peers.get(peerId)?.ualDispositions.get(ual);
  }

  unavailablePeerIds(): ReadonlySet<string> {
    return new Set([...this.#peers]
      .filter(([, state]) => state.phase.kind === 'unavailable')
      .map(([peerId]) => peerId));
  }
}
