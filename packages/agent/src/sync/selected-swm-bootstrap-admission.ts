// SPDX-License-Identifier: Apache-2.0

export type SelectedSwmBootstrapPhase = 'retry-required' | 'terminal';

export interface SelectedSwmBootstrapAdmissionSnapshot {
  readonly contextGraphIds: readonly string[];
  readonly phase: SelectedSwmBootstrapPhase;
}

export interface SelectedSwmBootstrapTransferOwner {
  readonly remotePeer: string;
  readonly contextGraphIds: readonly string[];
  readonly generation: number;
}

/** Identity-free aggregate used by operator status surfaces. */
export interface SelectedSwmBootstrapContextGraphSummary {
  readonly retryRequiredProviders: number;
  readonly terminalProviders: number;
}

interface SelectedSwmBootstrapAdmissionState extends SelectedSwmBootstrapAdmissionSnapshot {
  readonly generation: number;
}

function canonicalScope(contextGraphIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(contextGraphIds)].sort());
}

function sameScope(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((contextGraphId, index) => contextGraphId === right[index]);
}

/**
 * One explicit owner for selected-SWM bootstrap admission state.
 *
 * State is peer + graph-scope keyed: completing one scope suppresses duplicate
 * refreshes for that exact scope, while adding or removing an operator-selected
 * graph creates a new scope and therefore a new bounded admission.
 */
export class SelectedSwmBootstrapAdmission {
  readonly #byPeer = new Map<string, SelectedSwmBootstrapAdmissionState>();
  #nextGeneration = 0;

  #replace(
    remotePeer: string,
    contextGraphIds: readonly string[],
    phase: SelectedSwmBootstrapPhase,
  ): SelectedSwmBootstrapAdmissionState {
    const state = Object.freeze({
      contextGraphIds: canonicalScope(contextGraphIds),
      phase,
      generation: this.#nextGeneration += 1,
    });
    this.#byPeer.set(remotePeer, state);
    return state;
  }

  request(remotePeer: string, contextGraphIds: readonly string[]): boolean {
    const scope = canonicalScope(contextGraphIds);
    const current = this.#byPeer.get(remotePeer);
    if (scope.length === 0) {
      this.#replace(remotePeer, scope, 'terminal');
      return false;
    }
    if (
      current !== undefined
      && current.phase === 'terminal'
      && sameScope(current.contextGraphIds, scope)
    ) return false;
    if (current?.phase !== 'retry-required' || !sameScope(current.contextGraphIds, scope)) {
      this.#replace(remotePeer, scope, 'retry-required');
    }
    return true;
  }

  /**
   * Claim one concrete transfer generation before it enters peer single-flight.
   * A later queued transfer or operator scope change supersedes this owner, so
   * its older completion cannot clear the newer retry requirement.
   */
  beginTransfer(
    remotePeer: string,
    contextGraphIds: readonly string[],
  ): SelectedSwmBootstrapTransferOwner {
    const scope = canonicalScope(contextGraphIds);
    if (scope.length === 0) {
      throw new Error('selected SWM transfer requires a non-empty Context Graph scope');
    }
    const state = this.#replace(remotePeer, scope, 'retry-required');
    return Object.freeze({
      remotePeer,
      contextGraphIds: state.contextGraphIds,
      generation: state.generation,
    });
  }

  markTransferTerminal(owner: SelectedSwmBootstrapTransferOwner): boolean {
    const current = this.#byPeer.get(owner.remotePeer);
    if (
      current === undefined
      || current.generation !== owner.generation
      || !sameScope(current.contextGraphIds, owner.contextGraphIds)
    ) return false;
    this.#byPeer.set(owner.remotePeer, Object.freeze({
      ...current,
      phase: 'terminal',
    }));
    return true;
  }

  isRetryRequired(remotePeer: string): boolean {
    return this.#byPeer.get(remotePeer)?.phase === 'retry-required';
  }

  snapshot(remotePeer: string): SelectedSwmBootstrapAdmissionSnapshot | null {
    const state = this.#byPeer.get(remotePeer);
    if (state === undefined) return null;
    return Object.freeze({
      contextGraphIds: state.contextGraphIds,
      phase: state.phase,
    });
  }

  /**
   * Summarize one selected graph without exposing which providers own the
   * admission records. When `providerPeerIds` is supplied, stale records for
   * providers that are no longer designated for the graph are ignored.
   */
  summarizeContextGraph(
    contextGraphId: string,
    providerPeerIds?: readonly string[],
  ): SelectedSwmBootstrapContextGraphSummary {
    const providerFilter = providerPeerIds === undefined
      ? undefined
      : new Set(providerPeerIds);
    let retryRequiredProviders = 0;
    let terminalProviders = 0;
    for (const [remotePeer, state] of this.#byPeer) {
      if (providerFilter !== undefined && !providerFilter.has(remotePeer)) continue;
      if (!state.contextGraphIds.includes(contextGraphId)) continue;
      if (state.phase === 'retry-required') retryRequiredProviders += 1;
      else terminalProviders += 1;
    }
    return Object.freeze({ retryRequiredProviders, terminalProviders });
  }

  clear(remotePeer: string): void {
    this.#byPeer.delete(remotePeer);
  }

  clearAll(): void {
    this.#byPeer.clear();
  }

  get size(): number {
    return this.#byPeer.size;
  }
}
