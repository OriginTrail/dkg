// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayPeerDemandV1 } from './catalog-replay-recovery-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './catalog-peers-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';

/** Capacity belongs to the promise set; identity merging/pruning belongs to its caller. */
export type BoundedReplayTargetsV1<Target> = Readonly<{ kind: 'bounded'; targets: readonly Target[] }>
  | Readonly<{ kind: 'overflow' }>;
export function emptyReplayTargetsV1<Target>(): BoundedReplayTargetsV1<Target> {
  return { kind: 'bounded', targets: Object.freeze([]) };
}
export function mergeReplayTargetsV1<Target>(left: BoundedReplayTargetsV1<Target>,
  right: BoundedReplayTargetsV1<Target>,
  mergeAndPrune: (left: readonly Target[], right: readonly Target[]) => readonly Target[]): BoundedReplayTargetsV1<Target> {
  if (left.kind === 'overflow' || right.kind === 'overflow') return { kind: 'overflow' };
  const live = mergeAndPrune(left.targets, right.targets);
  return live.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 ? { kind: 'overflow' }
    : { kind: 'bounded', targets: Object.freeze([...live]) };
}

/** A provider result is recorded once in both the current run and retained pass. */
export type ReplayPeerOutcomeV1<Target> =
  | Readonly<{ kind: 'completed'; targets: readonly Target[] }>
  | Readonly<{ kind: 'not-provider' | 'local-unavailable' }>
  | Readonly<{ kind: 'provider-failed'; attributed: boolean }>;
export function recordReplayPeerOutcomeV1<Target>(run: ReplayRunEvidenceV1<Target>,
  pass: FullReplayPassV1<Target> | null, demand: Rfc64CatalogReplayPeerDemandV1,
  outcome: ReplayPeerOutcomeV1<Target>): void {
  run.record(demand, outcome);
  pass?.record(demand, outcome);
}

/** Recovery owns expected generations, evidence and observation as one pass. */
export class FullReplayPassV1<Target> {
  readonly #expected = new Map<string, { generation: number; replayed: boolean }>();
  targets: BoundedReplayTargetsV1<Target> = emptyReplayTargetsV1();
  replacesSnapshot = true;
  #coverageValid = true;
  unanswered = false;
  readonly #providers = new Map<string, number>();
  get corroborated(): boolean { return this.#providers.size > 0; }
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[]) {}

  include(demands: readonly (Rfc64CatalogReplayPeerDemandV1 & { staged: boolean })[], prior: BoundedReplayTargetsV1<Target> | null, run?: ReplayRunEvidenceV1<Target>): boolean {
    if (new Set([...this.#expected.keys(), ...demands.map(demand => demand.peerId)]).size > RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) return false;
    this.#coverageValid = true;
    for (const demand of demands) {
      if (this.#expected.get(demand.peerId)?.generation !== demand.generation) {
        this.#expected.set(demand.peerId, { generation: demand.generation, replayed: false });
      }
    }
    if (demands.some(demand => demand.staged)) {
      this.replacesSnapshot = false;
      if (prior !== null) this.#retain(prior);
    }
    if (run) {
      this.#retain(run.received);
      for (const [peer, generation] of run.providers) this.#providers.set(peer, generation);
    }
    return true;
  }
  replace(demand: Rfc64CatalogReplayPeerDemandV1): void {
    if (this.#expected.has(demand.peerId)) {
      this.#expected.set(demand.peerId, { generation: demand.generation, replayed: false });
      this.#providers.delete(demand.peerId);
    }
  }
  cancelled(demand: Rfc64CatalogReplayPeerDemandV1): boolean {
    const expected = this.#expected.get(demand.peerId);
    return expected?.generation === demand.generation && !expected.replayed;
  }
  /** Cancelled execution cannot retain expectations with no staged reservation owner.
   * Keep promises and surviving reservations, but require a new full request to
   * re-establish coverage after any expected generation was abandoned. */
  retireUnowned(isStaged: (demand: Rfc64CatalogReplayPeerDemandV1) => boolean): void {
    for (const [peerId, expected] of this.#expected) {
      if (!expected.replayed && !isStaged({ peerId, generation: expected.generation })) {
        this.#expected.delete(peerId);
        this.#coverageValid = false;
        this.replacesSnapshot = false;
      }
    }
  }
  record(demand: Rfc64CatalogReplayPeerDemandV1, outcome: ReplayPeerOutcomeV1<Target>): void {
    const expected = this.#expected.get(demand.peerId);
    if (expected !== undefined && demand.generation >= expected.generation) expected.replayed = true;
    this.unanswered ||= outcome.kind === 'local-unavailable' || outcome.kind === 'provider-failed';
    if (outcome.kind === 'completed') this.#providers.set(demand.peerId, demand.generation);
    // Retain immediately after the provider response, BEFORE receiver drain.
    if (outcome.kind === 'completed') this.#retain({ kind: 'bounded', targets: outcome.targets });
  }
  #retain(targets: BoundedReplayTargetsV1<Target>): void {
    this.targets = mergeReplayTargetsV1(this.targets, targets, this.merge);
  }
  get covered(): boolean { return this.#coverageValid && [...this.#expected.values()].every(expected => expected.replayed); }
  /** Only a receiver-drained parity read observes the completed generations. */
  observe(): void {
    for (const [peer, expected] of this.#expected) if (expected.replayed) this.#expected.delete(peer);
  }
}

export type ReplayObservationV1<Target> =
  | Readonly<{ kind: 'unobserved'; reason: 'pending' | 'drain-timeout' | 'budget-exhausted' | 'cancelled' | 'parity-error' }>
  | Readonly<{ kind: 'target-overflow' }>
  | Readonly<{ kind: 'parity'; targets: readonly Target[]; outcome: 'complete' | 'failed' }>;

/** One run owns provider attribution separately from its single observation. */
export class ReplayRunEvidenceV1<Target> {
  received: BoundedReplayTargetsV1<Target> = emptyReplayTargetsV1();
  readonly providers = new Map<string, number>();
  readonly #outcomes: ReplayPeerOutcomeV1<Target>['kind'][] = [];
  #unattributedProviderFailure = false;
  #observation: ReplayObservationV1<Target> = { kind: 'unobserved', reason: 'pending' };
  get observation(): ReplayObservationV1<Target> { return this.#observation; }
  get requested(): number { return this.#outcomes.filter(kind => kind === 'completed').length; }
  get providerFailures(): number { return this.#outcomes.filter(kind => kind === 'provider-failed').length; }
  get unanswered(): boolean { return this.#outcomes.some(kind => kind === 'provider-failed' || kind === 'local-unavailable'); }
  get peerFailures(): number { return this.#outcomes.filter(kind => kind === 'provider-failed' || kind === 'local-unavailable').length; }
  get unattributedProviderFailure(): boolean { return this.#unattributedProviderFailure; }
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[], readonly fullRequest = false) {}
  record(demand: Rfc64CatalogReplayPeerDemandV1, outcome: ReplayPeerOutcomeV1<Target>): void {
    this.#outcomes.push(outcome.kind);
    if (outcome.kind === 'completed') {
      this.received = mergeReplayTargetsV1(this.received, { kind: 'bounded', targets: outcome.targets }, this.merge);
      this.providers.set(demand.peerId, demand.generation);
      this.unobserved('pending');
    }
    if (outcome.kind === 'provider-failed' && !outcome.attributed) this.#unattributedProviderFailure = true;
  }
  unobserved(reason: Extract<ReplayObservationV1<Target>, { kind: 'unobserved' }>['reason']): void {
    this.#observation = { kind: 'unobserved', reason };
  }
  observe(targets: BoundedReplayTargetsV1<Target>, failed: boolean): void {
    this.#observation = targets.kind === 'overflow' ? { kind: 'target-overflow' }
      : { kind: 'parity', targets: targets.targets, outcome: failed ? 'failed' : 'complete' };
  }
}


/** The entire retained-state transition and caller result share one policy. */
export interface ReplayRetainedStateV1<Target> {
  promisedTargets: BoundedReplayTargetsV1<Target> | null;
  requiresFullReplay: boolean;
  unverified: boolean;
  fullPass: FullReplayPassV1<Target> | null;
}
export interface ReplayRunSettlementV1<Target> extends ReplayRetainedStateV1<Target> {
  readonly continueQueuedConnections: boolean;
  readonly result: Readonly<{ requested: number; failed: number }>;
}
export function resolveReplayRunSettlementV1<Target>(evidence: ReplayRunEvidenceV1<Target>,
  prior: ReplayRetainedStateV1<Target>, ownership: Readonly<{
    continueQueuedConnections: boolean; cancelled: boolean; hasStaged: boolean;
    isStaged(demand: Rfc64CatalogReplayPeerDemandV1): boolean;
  }>): ReplayRunSettlementV1<Target> {
  const continueQueuedConnections = !ownership.cancelled && ownership.continueQueuedConnections;
  const observation = evidence.observation;
  const observationFailed = observation.kind === 'target-overflow'
    || (observation.kind === 'parity' && observation.outcome === 'failed')
    || (observation.kind === 'unobserved' && (observation.reason === 'parity-error'
      || (observation.reason === 'budget-exhausted' && !continueQueuedConnections)));
  let requiresFullReplay = observationFailed || evidence.unattributedProviderFailure;
  let promisedTargets = prior.promisedTargets;
  const retain = (targets: BoundedReplayTargetsV1<Target>, replaces = false) => {
    promisedTargets = mergeReplayTargetsV1(replaces ? emptyReplayTargetsV1<Target>()
      : promisedTargets ?? emptyReplayTargetsV1<Target>(), targets, evidence.merge);
    requiresFullReplay ||= promisedTargets.kind === 'overflow';
  };
  let fullPass = prior.fullPass;
  const wasFullPass = fullPass?.covered ?? false;
  const observed = observation.kind !== 'unobserved';
  // A staged pass retains earlier corroboration even if the final peer is not a provider.
  const corroborated = evidence.requested > 0 || (wasFullPass && (fullPass?.corroborated ?? false));
  if (observation.kind === 'parity' && corroborated) {
    // Coverage can clear a witness despite a failed provider, but cannot discard
    // that provider's previously advertised heads by replacing the snapshot.
    retain({ kind: 'bounded', targets: observation.targets }, fullPass !== null && wasFullPass
      && fullPass.replacesSnapshot && !fullPass.unanswered && !evidence.unanswered);
  } else if (observation.kind === 'target-overflow') promisedTargets = { kind: 'overflow' };
  else if (evidence.received.kind === 'overflow' || evidence.received.targets.length > 0) retain(evidence.received);
  let unverified = prior.unverified;
  if (corroborated && observed) unverified = false;
  else if (!observed || (evidence.fullRequest && evidence.providerFailures > 0)
    || (wasFullPass && fullPass?.unanswered === true)) unverified = true;
  if (wasFullPass && observed) fullPass = null;
  if (ownership.cancelled && fullPass) {
    retain(fullPass.targets);
    fullPass.retireUnowned(ownership.isStaged);
    if (!ownership.hasStaged) fullPass = null;
  }
  return { continueQueuedConnections, promisedTargets, fullPass, unverified,
    result: Object.freeze({ requested: evidence.requested, failed: evidence.peerFailures + Number(observationFailed) }),
    requiresFullReplay: requiresFullReplay || (prior.requiresFullReplay && !(observed && corroborated && wasFullPass)),
  };
}
