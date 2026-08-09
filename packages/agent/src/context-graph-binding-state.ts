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
    authoritativeOnChainId?: string,
  ): ContextGraphBinding | undefined {
    if (authoritativeOnChainId !== undefined) {
      return {
        bindingKind: 'authoritative',
        onChainId: authoritativeOnChainId,
      };
    }
    return this.reverseCandidates.get(localCgId);
  }

  bindAuthoritative(
    localCgId: string,
    authoritativeOnChainId: string | undefined,
    newOnChainId: string,
  ): ContextGraphBindingTransition {
    const previous = this.currentBindingFor(localCgId, authoritativeOnChainId);
    const current: AuthoritativeContextGraphBinding = {
      bindingKind: 'authoritative',
      onChainId: newOnChainId,
    };
    this.reverseCandidates.delete(localCgId);
    const changed = !bindingsEqual(previous, current);
    if (changed) this.bump(localCgId);
    return {
      previous,
      current,
      changed,
      onChainIdChanged: previous !== undefined && previous.onChainId !== newOnChainId,
    };
  }

  bindReverseCandidate(
    localCgId: string,
    authoritativeOnChainId: string | undefined,
    newOnChainId: string,
    nameHash: string,
  ): ContextGraphBindingTransition {
    const previous = this.currentBindingFor(localCgId, authoritativeOnChainId);
    if (authoritativeOnChainId !== undefined) {
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
      onChainId: newOnChainId,
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
      onChainIdChanged: previous !== undefined && previous.onChainId !== newOnChainId,
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
    authoritativeOnChainId: string | undefined,
    target: ContextGraphBindingTarget,
  ): boolean {
    const current = this.currentBindingFor(localCgId, authoritativeOnChainId);
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
