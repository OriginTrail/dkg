// SPDX-License-Identifier: Apache-2.0

import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';

const MAX_UNRESOLVED_PEERS_V1 = 64;

export interface Rfc64CatalogReplayPeerDemandV1 {
  readonly peerId: string;
  readonly generation: number;
}

/** Opaque, idempotent ownership of one exact reconnect demand. */
export interface Rfc64CatalogReplayPeerFenceLeaseV1
  extends Rfc64CatalogReplayPeerDemandV1 {
  release(): void;
}

export type Rfc64CatalogReplayPeerResultV1<Target> = Readonly<{
  status: 'completed';
  targets: readonly Target[];
}> | Readonly<{
  status: 'not-provider';
}>;

/** Closed runtime commands; peer seeding and full-replay evidence cannot diverge. */
export type Rfc64CatalogReplayRecoveryCommandV1 = Readonly<{
  readonly contextGraphId: string;
  readonly policyDigest: string;
} & (
  | {
      readonly kind: 'full-connected-peers';
      readonly connectedPeerIds: readonly string[];
    }
  | { readonly kind: 'pending-recovery' }
  | {
      readonly kind: 'connection-demand';
      readonly demand: Rfc64CatalogReplayPeerDemandV1;
    }
)>;

export interface Rfc64CatalogReplayRecoveryPortsV1<Target> {
  requestPeer(
    contextGraphId: string,
    peerId: string,
  ): Promise<Rfc64CatalogReplayPeerResultV1<Target>>;
  whenReceiverIdle(): Promise<void>;
  targetIdentity(target: Target): string;
  parityFailed(contextGraphId: string, targets: readonly Target[]): Promise<boolean>;
}

export interface Rfc64CatalogReplayRecoveryResultV1 {
  readonly requested: number;
  readonly failed: number;
}

export interface Rfc64CatalogReplayRecoveryStatusV1 {
  readonly active: boolean;
  readonly failed: boolean;
}

/**
 * One owner for reconnect generations, pending-peer deduplication, and the
 * finite amount of peer work a coalesced replay may perform. A peer ID is not
 * itself a completion token: enqueueing the same peer after its earlier demand
 * was drained creates a newer generation that must be replayed or left
 * fail-closed when the run budget is exhausted.
 */
class Rfc64CatalogReplayPeerWorklistV1 {
  readonly #pending = new Map<string, number>();
  #nextGeneration = 0;
  #remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
  #overflowed = false;

  beginRun(): void {
    this.#remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
  }

  acquire(peerId: string): Rfc64CatalogReplayPeerFenceLeaseV1 | null {
    if (
      !this.#pending.has(peerId)
      && this.#pending.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1
    ) {
      this.#overflowed = true;
      return null;
    }
    const generation = ++this.#nextGeneration;
    this.#pending.set(peerId, generation);
    let released = false;
    return Object.freeze({
      peerId,
      generation,
      release: () => {
        if (released) return;
        released = true;
        if (this.#pending.get(peerId) === generation) this.#pending.delete(peerId);
      },
    });
  }

  seed(peerId: string): void {
    if (this.#pending.has(peerId)) return;
    if (this.#pending.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
      this.#overflowed = true;
      return;
    }
    this.#pending.set(peerId, ++this.#nextGeneration);
  }

  seedDemand(demand: Rfc64CatalogReplayPeerDemandV1): void {
    const current = this.#pending.get(demand.peerId);
    if (current === undefined || current < demand.generation) {
      this.#pending.set(demand.peerId, demand.generation);
    }
    this.#nextGeneration = Math.max(this.#nextGeneration, demand.generation);
  }

  drain(): readonly Rfc64CatalogReplayPeerDemandV1[] {
    if (this.#remaining === 0) return Object.freeze([]);
    const demands = [...this.#pending.entries()]
      .slice(0, this.#remaining)
      .map(([peerId, generation]) => Object.freeze({ peerId, generation }));
    for (const demand of demands) {
      if (this.#pending.get(demand.peerId) === demand.generation) {
        this.#pending.delete(demand.peerId);
      }
    }
    this.#remaining -= demands.length;
    return Object.freeze(demands);
  }

  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  get exhausted(): boolean {
    return this.#overflowed || (this.#remaining === 0 && this.hasPending);
  }

  settleOverflow(): void {
    this.#overflowed = false;
  }
}

interface ReplayProgressV1 {
  readonly policyDigest: string;
  readonly peerWorklist: Rfc64CatalogReplayPeerWorklistV1;
  /** Provider-specific failures survive later scoped connection runs. */
  readonly unresolvedPeers: Set<string>;
  /** Unattributed parity/overflow failures require one successful full pass. */
  requiresFullReplay: boolean;
  /** OR-merged across every request that joins the active completion. */
  requestedFullReplay: boolean;
  token: number;
  active: boolean;
  failed: boolean;
  completion: Promise<Readonly<Rfc64CatalogReplayRecoveryResultV1>> | null;
}

/**
 * Owns the complete per-CG replay recovery lifecycle: admission leases,
 * reconnect work, provider failure attribution, completion coalescing, and the
 * status revision observed by the agent's operational projection.
 */
export class Rfc64CatalogReplayRecoveryRuntimeV1<Target> {
  readonly #byContextGraph = new Map<string, ReplayProgressV1>();
  readonly #ports: Rfc64CatalogReplayRecoveryPortsV1<Target>;
  #revision = 0;

  constructor(ports: Rfc64CatalogReplayRecoveryPortsV1<Target>) {
    this.#ports = ports;
  }

  get revision(): number {
    return this.#revision;
  }

  status(
    contextGraphId: string,
    policyDigest: string,
  ): Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null {
    const progress = this.#byContextGraph.get(contextGraphId);
    if (progress === undefined || progress.policyDigest !== policyDigest) return null;
    return Object.freeze({ active: progress.active, failed: progress.failed });
  }

  clear(contextGraphId: string): void {
    if (this.#byContextGraph.delete(contextGraphId)) this.#bumpRevision();
  }

  reset(): void {
    if (this.#byContextGraph.size > 0) {
      this.#byContextGraph.clear();
      this.#bumpRevision();
    }
  }

  markPeerPending(
    contextGraphId: string,
    policyDigest: string,
    peerId: string,
  ): Rfc64CatalogReplayPeerFenceLeaseV1 | null {
    const progress = this.#progressFor(contextGraphId, policyDigest);
    const worklistLease = progress.peerWorklist.acquire(peerId);
    if (worklistLease === null) return null;
    if (!progress.active) {
      progress.active = true;
      progress.failed = false;
      this.#bumpRevision();
    }
    let released = false;
    return Object.freeze({
      peerId: worklistLease.peerId,
      generation: worklistLease.generation,
      release: () => {
        if (released) return;
        released = true;
        worklistLease.release();
        if (this.#byContextGraph.get(contextGraphId) !== progress) return;
        if (!progress.peerWorklist.hasPending && progress.completion === null && progress.active) {
          progress.active = false;
          this.#bumpRevision();
        }
      },
    });
  }

  request(
    input: Rfc64CatalogReplayRecoveryCommandV1,
  ): Promise<Readonly<Rfc64CatalogReplayRecoveryResultV1>> {
    const progress = this.#progressFor(input.contextGraphId, input.policyDigest);
    if (input.kind === 'full-connected-peers') {
      const connectedPeers = snapshotRfc64PublicCatalogAnnouncementPeersV1(
        input.connectedPeerIds.slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1),
      );
      for (const peer of connectedPeers) progress.peerWorklist.seed(peer);
      progress.requestedFullReplay = true;
    } else if (input.kind === 'connection-demand') {
      progress.peerWorklist.seedDemand(input.demand);
    }
    for (const peer of progress.unresolvedPeers) progress.peerWorklist.seed(peer);
    // A drained worklist can still have an in-flight provider/parity pass.
    if (progress.completion !== null) return progress.completion;
    if (!progress.peerWorklist.hasPending) {
      return Promise.resolve(Object.freeze({ requested: 0, failed: 0 }));
    }
    progress.peerWorklist.beginRun();
    progress.token += 1;
    const token = progress.token;
    progress.active = true;
    this.#bumpRevision();
    const run = this.#execute(input, progress, token);
    progress.completion = run;
    return run;
  }

  async #execute(
    input: Rfc64CatalogReplayRecoveryCommandV1,
    progress: ReplayProgressV1,
    token: number,
  ): Promise<Readonly<Rfc64CatalogReplayRecoveryResultV1>> {
    let requested = 0;
    let failed = 0;
    let replayFailed = true;
    let requiresFullReplay = false;
    try {
      const manifests: Target[][] = [];
      for (;;) {
        const replayDemands = progress.peerWorklist.drain();
        await Promise.all(replayDemands.map(async ({ peerId }) => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const completion = await this.#ports.requestPeer(input.contextGraphId, peerId);
              progress.unresolvedPeers.delete(peerId);
              if (completion.status === 'completed') {
                manifests.push([...completion.targets]);
                requested += 1;
              }
              return;
            } catch {
              if (attempt === 1) {
                if (!this.#retainPeerFailure(progress, peerId)) requiresFullReplay = true;
                failed += 1;
              }
            }
          }
        }));
        // Completion-capable provider responses are returned only after every
        // promised announcement is synchronously admitted at this receiver.
        await this.#ports.whenReceiverIdle();
        if (progress.peerWorklist.exhausted) {
          requiresFullReplay = true;
          failed += 1;
          break;
        }
        if (progress.peerWorklist.hasPending) continue;

        const promisedByIdentity = new Map<string, Target>();
        for (const target of manifests.flat()) {
          promisedByIdentity.set(this.#ports.targetIdentity(target), target);
        }
        const promised = [...promisedByIdentity.values()];
        const parityFailed = promised.length
          > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
          || await this.#ports.parityFailed(input.contextGraphId, promised);
        // A reconnect generation arriving during the durable parity read owns
        // another pass. The worklist budget keeps that fence finite.
        if (progress.peerWorklist.exhausted) {
          requiresFullReplay = true;
          failed += 1;
          break;
        }
        if (progress.peerWorklist.hasPending) continue;
        if (parityFailed) {
          failed += 1;
          requiresFullReplay = true;
        }
        break;
      }
      replayFailed = failed > 0;
      return Object.freeze({ requested, failed });
    } catch {
      requiresFullReplay = true;
      failed += 1;
      return Object.freeze({ requested, failed });
    } finally {
      const current = this.#byContextGraph.get(input.contextGraphId);
      if (current === progress && current.token === token) {
        current.active = false;
        if (requiresFullReplay) current.requiresFullReplay = true;
        if (!replayFailed && current.requestedFullReplay) current.requiresFullReplay = false;
        current.requestedFullReplay = false;
        current.failed = current.unresolvedPeers.size > 0 || current.requiresFullReplay;
        current.completion = null;
        current.peerWorklist.settleOverflow();
        this.#bumpRevision();
      }
    }
  }

  #progressFor(contextGraphId: string, policyDigest: string): ReplayProgressV1 {
    let progress = this.#byContextGraph.get(contextGraphId);
    if (progress === undefined || progress.policyDigest !== policyDigest) {
      progress = {
        policyDigest,
        peerWorklist: new Rfc64CatalogReplayPeerWorklistV1(),
        unresolvedPeers: new Set(),
        requiresFullReplay: false,
        requestedFullReplay: false,
        token: 0,
        active: false,
        failed: false,
        completion: null,
      };
      this.#byContextGraph.set(contextGraphId, progress);
    }
    return progress;
  }

  /** Retain bounded attribution; overflow survives as a full-replay witness. */
  #retainPeerFailure(progress: ReplayProgressV1, peerId: string): boolean {
    if (
      progress.unresolvedPeers.has(peerId)
      || progress.unresolvedPeers.size < MAX_UNRESOLVED_PEERS_V1
    ) {
      progress.unresolvedPeers.add(peerId);
      return true;
    }
    progress.requiresFullReplay = true;
    return false;
  }

  #bumpRevision(): void {
    this.#revision += 1;
  }
}
