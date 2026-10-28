// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayPeerDemandV1 } from './catalog-replay-recovery-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './catalog-peers-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';

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
  targets: readonly Target[] | null = Object.freeze([]);
  replacesSnapshot = true;
  unanswered = false;
  readonly #providers = new Map<string, number>();
  get corroborated(): boolean { return this.#providers.size > 0; }
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[]) {}

  include(demands: readonly (Rfc64CatalogReplayPeerDemandV1 & { staged: boolean })[], prior: readonly Target[] | null, run: ReplayRunEvidenceV1<Target>): boolean {
    if (new Set([...this.#expected.keys(), ...demands.map(demand => demand.peerId)]).size > RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) return false;
    for (const demand of demands) {
      if (this.#expected.get(demand.peerId)?.generation !== demand.generation) {
        this.#expected.set(demand.peerId, { generation: demand.generation, replayed: false });
      }
    }
    if (demands.some(demand => demand.staged)) {
      this.replacesSnapshot = false;
      this.#retain(prior ?? []);
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
    if (outcome.kind === 'completed') this.#retain(outcome.targets);
  }
  #retain(targets: readonly Target[]): void {
    if (this.targets === null) return;
    const live = this.merge(this.targets, targets);
    this.targets = live.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 ? null : Object.freeze([...live]);
  }
  get covered(): boolean { return [...this.#expected.values()].every(expected => expected.replayed); }
  /** Only a receiver-drained parity read observes the completed generations. */
  observe(): void {
    for (const [peer, expected] of this.#expected) if (expected.replayed) this.#expected.delete(peer);
  }
}

/** One run owns its provider responses and the exact observation they reached. */
export class ReplayRunEvidenceV1<Target> {
  received: readonly Target[] = [];
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
    this.received = this.merge(this.received, targets);
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
  observe(targets: readonly Target[] | null, failed: boolean): void {
    this.observation = targets === null ? { kind: 'overflow' } : { kind: 'parity', targets, failed };
    if (targets === null || failed) this.failedObservation();
  }
}
