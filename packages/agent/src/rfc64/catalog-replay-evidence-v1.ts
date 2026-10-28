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
  unanswered = false;
  readonly #providers = new Map<string, number>();
  get corroborated(): boolean { return this.#providers.size > 0; }
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[]) {}

  include(demands: readonly (Rfc64CatalogReplayPeerDemandV1 & { staged: boolean })[], prior: BoundedReplayTargetsV1<Target> | null, run: ReplayRunEvidenceV1<Target>): boolean {
    if (new Set([...this.#expected.keys(), ...demands.map(demand => demand.peerId)]).size > RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) return false;
    for (const demand of demands) {
      if (this.#expected.get(demand.peerId)?.generation !== demand.generation) {
        this.#expected.set(demand.peerId, { generation: demand.generation, replayed: false });
      }
    }
    if (demands.some(demand => demand.staged)) {
      this.replacesSnapshot = false;
      if (prior !== null) this.#retain(prior);
    }
    this.#retain(run.received);
    for (const [peer, generation] of run.providers) this.#providers.set(peer, generation);
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
  get covered(): boolean { return [...this.#expected.values()].every(expected => expected.replayed); }
  /** Only a receiver-drained parity read observes the completed generations. */
  observe(): void {
    for (const [peer, expected] of this.#expected) if (expected.replayed) this.#expected.delete(peer);
  }
}

/** One run owns its provider responses and the exact observation they reached. */
export class ReplayRunEvidenceV1<Target> {
  received: BoundedReplayTargetsV1<Target> = emptyReplayTargetsV1();
  readonly providers = new Map<string, number>();
  readonly #outcomes: ReplayPeerOutcomeV1<Target>['kind'][] = [];
  #observationFailures = 0;
  requiresFullReplay = false;
  get requested(): number { return this.#outcomes.filter(kind => kind === 'completed').length; }
  get providerFailures(): number { return this.#outcomes.filter(kind => kind === 'provider-failed').length; }
  get unanswered(): boolean { return this.#outcomes.some(kind => kind === 'provider-failed' || kind === 'local-unavailable'); }
  get failed(): number { return this.#observationFailures + this.#outcomes.filter(kind => kind === 'provider-failed' || kind === 'local-unavailable').length; }
  observation: Readonly<{ kind: 'unobserved' }> | Readonly<{ kind: 'overflow' }>
    | Readonly<{ kind: 'parity'; targets: readonly Target[]; failed: boolean }> = { kind: 'unobserved' };
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[], readonly fullRequest = false) {}
  private completed(demand: Rfc64CatalogReplayPeerDemandV1, targets: readonly Target[]): void {
    this.received = mergeReplayTargetsV1(this.received, { kind: 'bounded', targets }, this.merge);
    this.providers.set(demand.peerId, demand.generation);
    this.unobserved();
  }
  record(demand: Rfc64CatalogReplayPeerDemandV1, outcome: ReplayPeerOutcomeV1<Target>): void {
    this.#outcomes.push(outcome.kind);
    if (outcome.kind === 'completed') this.completed(demand, outcome.targets);
    if (outcome.kind === 'provider-failed' && !outcome.attributed) this.requiresFullReplay = true;
  }
  failedObservation(): void { this.#observationFailures++; this.requiresFullReplay = true; }
  unobserved(): void { this.observation = { kind: 'unobserved' }; }
  observe(targets: BoundedReplayTargetsV1<Target>, failed: boolean): void {
    this.observation = targets.kind === 'overflow' ? { kind: 'overflow' } : { kind: 'parity', targets: targets.targets, failed };
    if (targets.kind === 'overflow' || failed) this.failedObservation();
  }
}
