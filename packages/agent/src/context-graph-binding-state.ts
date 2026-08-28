// SPDX-License-Identifier: Apache-2.0

export type AuthoritativeContextGraphBinding = {
  bindingKind: 'authoritative';
  onChainId: string;
};

export type ReverseNameHashContextGraphBinding = {
  bindingKind: 'reverse-name-hash';
  onChainId: string;
  nameHash: string;
};

export type ContextGraphBinding =
  | AuthoritativeContextGraphBinding
  | ReverseNameHashContextGraphBinding;

export type ContextGraphBindingTarget = ContextGraphBinding & {
  bindingGeneration: number;
};

export type ContextGraphBindingTransition = {
  previous: ContextGraphBinding | undefined;
  current: ContextGraphBinding;
  changed: boolean;
  onChainIdChanged: boolean;
};

/** The durable portion of a subscription that owns an authoritative binding. */
export type ContextGraphBindingSubscription = {
  onChainId?: string;
};

export type ContextGraphBindingSubscriptionState = ContextGraphBindingSubscription & {
  subscribed?: boolean;
  coreHosted?: boolean;
};

export type ContextGraphBindingSubscriptionFacts = {
  readonly reverseCandidateCleared: boolean;
  readonly admitted: boolean;
};

/** Contract Context Graph ids are positive, canonically formatted decimals. */
export function isCanonicalPositiveContextGraphId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function requireCanonicalPositiveContextGraphId(value: string): string {
  if (!isCanonicalPositiveContextGraphId(value)) {
    throw new TypeError(`Invalid Context Graph on-chain id: ${JSON.stringify(value)}`);
  }
  return value;
}

function bindingsEqual(
  left: ContextGraphBinding | undefined,
  right: ContextGraphBinding,
): boolean {
  if (!left || left.bindingKind !== right.bindingKind) return false;
  if (left.onChainId !== right.onChainId) return false;
  return left.bindingKind === 'authoritative'
    || left.nameHash === (right as ReverseNameHashContextGraphBinding).nameHash;
}

/**
 * Single process-local owner for Context Graph binding provenance and fences.
 *
 * Authoritative ids remain stored on the durable subscription supplied by the
 * caller. Reverse-name-hash candidates live only here, so they cannot leak into
 * subscription persistence. Consumers ask this registry for the current typed
 * binding or whether a captured target is still current; they never inspect a
 * side map or reconstruct the provenance rules themselves.
 */
export class ContextGraphBindingState {
  private readonly reverseCandidates = new Map<
    string,
    ReverseNameHashContextGraphBinding
  >();

  private readonly generations = new Map<string, number>();

  /** Never reset: a deleted and recreated local id must not reuse an old fence. */
  private nextGeneration = 0;

  currentBindingFor(
    localCgId: string,
    subscription: ContextGraphBindingSubscription | undefined,
  ): ContextGraphBinding | undefined {
    if (subscription?.onChainId !== undefined) {
      if (!isCanonicalPositiveContextGraphId(subscription.onChainId)) return undefined;
      return {
        bindingKind: 'authoritative',
        onChainId: subscription.onChainId,
      };
    }
    return this.reverseCandidates.get(localCgId);
  }

  hasBindingCandidate(
    localCgId: string,
    subscription: ContextGraphBindingSubscription | undefined,
  ): boolean {
    return this.currentBindingFor(localCgId, subscription) !== undefined;
  }

  matchesReverseCandidate(
    localCgId: string,
    subscription: ContextGraphBindingSubscription | undefined,
    onChainId: string,
  ): boolean {
    const binding = this.currentBindingFor(localCgId, subscription);
    return binding?.bindingKind === 'reverse-name-hash'
      && binding.onChainId === onChainId;
  }

  /**
   * Apply the binding-owned portion of one normalized subscription transition.
   * The lifecycle layer supplies the canonical next commitment and consumes
   * binding facts without reconstructing provenance. Consumer-specific cleanup
   * policy remains outside this registry.
   */
  applySubscriptionTransition(
    localCgId: string,
    previous: ContextGraphBindingSubscriptionState | undefined,
    next: ContextGraphBindingSubscriptionState,
    nextNameHash: string,
  ): ContextGraphBindingSubscriptionFacts {
    const reverseCandidate = this.reverseCandidates.get(localCgId);
    const admitted = next.subscribed === true || next.coreHosted === true;
    const retainsReverseCandidate = previous !== undefined
      && previous.onChainId === undefined
      && next.onChainId === undefined
      && admitted
      && reverseCandidate?.nameHash === nextNameHash;
    const reverseCandidateCleared = retainsReverseCandidate
      ? false
      : this.clear(localCgId);
    return {
      reverseCandidateCleared,
      admitted,
    };
  }

  bindAuthoritative(
    localCgId: string,
    subscription: ContextGraphBindingSubscription,
    newOnChainId: string,
  ): ContextGraphBindingTransition {
    const canonicalOnChainId = requireCanonicalPositiveContextGraphId(newOnChainId);
    const previous = this.currentBindingFor(localCgId, subscription);
    const previousOnChainId = subscription.onChainId ?? previous?.onChainId;
    const current: AuthoritativeContextGraphBinding = {
      bindingKind: 'authoritative',
      onChainId: canonicalOnChainId,
    };
    this.reverseCandidates.delete(localCgId);
    const changed = !bindingsEqual(previous, current);
    if (changed) this.bump(localCgId);
    subscription.onChainId = canonicalOnChainId;
    return {
      previous,
      current,
      changed,
      onChainIdChanged: previousOnChainId !== undefined
        && previousOnChainId !== canonicalOnChainId,
    };
  }

  bindReverseCandidate(
    localCgId: string,
    subscription: ContextGraphBindingSubscription,
    newOnChainId: string,
    nameHash: string,
  ): ContextGraphBindingTransition {
    const canonicalOnChainId = requireCanonicalPositiveContextGraphId(newOnChainId);
    const previous = this.currentBindingFor(localCgId, subscription);
    if (subscription.onChainId !== undefined) {
      requireCanonicalPositiveContextGraphId(subscription.onChainId);
      this.reverseCandidates.delete(localCgId);
      return {
        previous,
        current: previous as AuthoritativeContextGraphBinding,
        changed: false,
        onChainIdChanged: false,
      };
    }
    const current: ReverseNameHashContextGraphBinding = {
      bindingKind: 'reverse-name-hash',
      onChainId: canonicalOnChainId,
      nameHash,
    };
    const changed = !bindingsEqual(previous, current);
    if (changed) {
      this.reverseCandidates.set(localCgId, current);
      this.bump(localCgId);
    }
    return {
      previous,
      current,
      changed,
      onChainIdChanged: previous !== undefined && previous.onChainId !== canonicalOnChainId,
    };
  }

  /** Clear a reverse candidate and invalidate work captured against it. */
  clear(localCgId: string): boolean {
    if (!this.reverseCandidates.delete(localCgId)) return false;
    this.bump(localCgId);
    return true;
  }

  /** Invalidate every captured target even when there is no reverse candidate. */
  invalidate(localCgId: string): number {
    this.reverseCandidates.delete(localCgId);
    return this.bump(localCgId);
  }

  /** Reclaim all process-local state after a subscription record is deleted. */
  delete(localCgId: string): void {
    this.reverseCandidates.delete(localCgId);
    this.generations.delete(localCgId);
  }

  bump(localCgId: string): number {
    const generation = ++this.nextGeneration;
    this.generations.set(localCgId, generation);
    return generation;
  }

  capture(localCgId: string): number {
    return this.generations.get(localCgId) ?? 0;
  }

  isGenerationCurrent(localCgId: string, generation: number): boolean {
    return this.capture(localCgId) === generation;
  }

  targetStillCurrent(
    localCgId: string,
    subscription: ContextGraphBindingSubscription | undefined,
    target: ContextGraphBindingTarget,
  ): boolean {
    const current = this.currentBindingFor(localCgId, subscription);
    return bindingsEqual(current, target)
      && this.isGenerationCurrent(localCgId, target.bindingGeneration);
  }

  /** Test/diagnostic visibility without exposing the backing maps. */
  get size(): number {
    return this.reverseCandidates.size;
  }

  get generationCount(): number {
    return this.generations.size;
  }
}
