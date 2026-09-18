// SPDX-License-Identifier: Apache-2.0

import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';

const MAX_UNRESOLVED_PEERS_V1 = 64;
/**
 * Consecutive failed replays after which a retained provider stops being
 * re-seeded *as a retained provider*. It is still dialed whenever it appears
 * in a full pass's own connected-peer set or raises a fresh connection demand;
 * what the bound stops is the standing retry that would otherwise spend the
 * run's demand budget on a dead dial under every command kind. Its attribution
 * is kept and reported throughout.
 */
const MAX_RETAINED_REPLAY_RETRIES_V1 = 4;
/**
 * Worklist slots one full pass may spend re-dialing retained providers, so a
 * saturated attribution set cannot crowd that pass's own connected-peer set
 * out of the worklist. It bounds THAT path only: `acquire` fences and
 * `seedDemand` re-seeds also occupy `#pending` and respect no floor, so a
 * burst of reconnect demands can still leave a pass no room. Without it a
 * Context Graph whose attribution set is saturated lets 64 retained providers
 * take every slot, no connected provider is dialed at all, and
 * `requested === 0` on every run -- which the corroboration contract in
 * `#execute` correctly but unhelpfully reports as uncorroborated for as long
 * as they stay attributed. Scoped runs do not apply it: there the retained set
 * IS the work, and `MAX_RETAINED_REPLAY_RETRIES_V1` bounds its cost.
 */
const MAX_FULL_PASS_RETAINED_SEEDS_V1 = Math.floor(
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 / 2,
);

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
}> | Readonly<{
  /**
   * A local precondition (no catalog service, no network identity) stopped the
   * dial before it reached the peer. It is not provider evidence: it may
   * neither attribute a failure to that peer nor clear one already attributed.
   */
  status: 'local-unavailable';
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
  /**
   * Parity or worklist-overflow evidence that this node's applied rows may be
   * incomplete. Never set by a provider that merely failed to answer.
   */
  readonly failed: boolean;
  /** Retained providers whose last replay failed; retried, never blocking. */
  readonly unresolvedPeerCount: number;
  /**
   * The last full pass reached no provider at all while at least one dial
   * failed, so nothing corroborated the applied rows. Distinct from `failed`,
   * which is positive evidence that rows are missing: an empty promised set
   * makes parity vacuously true, and "nothing was verified" must not be
   * reported as "every provider agrees".
   */
  readonly unverified: boolean;
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

  /**
   * Bounded seeding: a peer that does not fit the worklist is deferred to a
   * later run instead of overflowing it. Returns false when the peer was not
   * queued, so a caller can withhold full-pass entitlement from a pass that
   * could not cover every peer it was asked to cover. Seeding may not raise a
   * full-replay witness: not dialing a peer is no evidence about applied rows.
   */
  seedBounded(peerId: string): boolean {
    if (this.#pending.has(peerId)) return true;
    if (this.#pending.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) return false;
    this.#pending.set(peerId, ++this.#nextGeneration);
    return true;
  }

  /** Forget a queued demand for a peer that can no longer be replayed from. */
  discard(peerId: string): void {
    this.#pending.delete(peerId);
  }

  /**
   * Deliberately unbounded, unlike `seedBounded`. Every demand here was already
   * admitted by `acquire`, whose own bound is what limits concurrent reconnect
   * ownership; refusing one at this point would silently cancel a live peer's
   * replay with no retry, because the connection runtime debounces re-prepare
   * for 60s. Re-seeding after `drain` freed the slot can therefore carry
   * `#pending` past the bound, and `#remaining === 0 && hasPending` then trips
   * the fail-closed `exhausted` fence into a full-replay witness for what was
   * really run-budget exhaustion. That conflation is a known residual (review
   * thread "the dead-dial / overflow problem"): fixing it means giving fresh
   * demands their own budget or starting a follow-on run, not dropping them.
   */
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

interface ReplayProgressV1<Target> {
  readonly policyDigest: string;
  readonly peerWorklist: Rfc64CatalogReplayPeerWorklistV1;
  /**
   * Provider-specific failures survive later scoped connection runs, each with
   * its consecutive-failure count so retries stay bounded.
   */
  readonly unresolvedPeers: Map<string, number>;
  /** Unattributed parity/overflow failures require one successful full pass. */
  requiresFullReplay: boolean;
  /** OR-merged across every request that joins the active completion. */
  requestedFullReplay: boolean;
  token: number;
  active: boolean;
  /** The last full pass obtained no provider manifest at all. */
  unverified: boolean;
  /**
   * Bounded provider promises retained for the operational completeness
   * projection. A complete connected-peer pass replaces the snapshot; scoped
   * recovery can only add evidence until another complete pass supersedes it.
   * `null` means no bounded authoritative snapshot is available.
   */
  promisedTargets: readonly Target[] | null;
  completion: Promise<Readonly<Rfc64CatalogReplayRecoveryResultV1>> | null;
}

/**
 * Owns the complete per-CG replay recovery lifecycle: admission leases,
 * reconnect work, provider failure attribution, completion coalescing, and the
 * status revision observed by the agent's operational projection.
 */
export class Rfc64CatalogReplayRecoveryRuntimeV1<Target> {
  readonly #byContextGraph = new Map<string, ReplayProgressV1<Target>>();
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
    return Object.freeze({
      active: progress.active,
      // Derived, never stored. A mirrored field can only desync from the
      // witness it mirrors: a fence that activates the Context Graph and is
      // released without a run would otherwise report a witnessed graph clean.
      failed: progress.requiresFullReplay,
      unresolvedPeerCount: progress.unresolvedPeers.size,
      unverified: progress.unverified,
    });
  }

  /**
   * Last bounded provider promise set for row-completeness projection. The
   * returned array is immutable and belongs to the same revision domain as
   * {@link status}.
   */
  promisedTargets(contextGraphId: string, policyDigest: string): readonly Target[] | null {
    const progress = this.#byContextGraph.get(contextGraphId);
    if (progress === undefined || progress.policyDigest !== policyDigest) return null;
    return progress.promisedTargets;
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
    let droppedProviders = false;
    if (input.kind === 'full-connected-peers') {
      // Validate before touching retained state: this throws synchronously on
      // an invalid or duplicated peer id, and a command the runtime rejects
      // must not have already discarded provider attribution on its way out.
      const connectedPeers = snapshotRfc64PublicCatalogAnnouncementPeersV1(
        input.connectedPeerIds.slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1),
      );
      droppedProviders = this.#dropDisconnectedUnresolvedPeers(
        progress,
        input.connectedPeerIds,
      );
      // Retained providers are seeded before the connected fill. The drop above
      // reads the untruncated connected set, so a retained provider past the
      // truncation bound is kept; seeding it after the fill would leave it kept
      // but never dialed, and it could then never clear.
      this.#seedRetainedProviders(progress, MAX_FULL_PASS_RETAINED_SEEDS_V1);
      let coveredEveryConnectedPeer = true;
      for (const peer of connectedPeers) {
        if (!progress.peerWorklist.seedBounded(peer)) coveredEveryConnectedPeer = false;
      }
      // A pass that could not queue every peer it was handed is not a full
      // pass and may not clear a witness. It is not evidence of missing rows
      // either, so it must not raise one. This can only withhold entitlement
      // while retained providers are crowding out the connected fill, and
      // `MAX_RETAINED_REPLAY_RETRIES_V1` bounds that to a handful of runs, so
      // it cannot become a standing block on a node with many connections.
      if (coveredEveryConnectedPeer) progress.requestedFullReplay = true;
    } else {
      if (input.kind === 'connection-demand') progress.peerWorklist.seedDemand(input.demand);
      this.#seedRetainedProviders(progress);
    }
    // A drained worklist can still have an in-flight provider/parity pass.
    if (progress.completion !== null) {
      if (droppedProviders) this.#bumpRevision();
      return progress.completion;
    }
    if (!progress.peerWorklist.hasPending) {
      // No run will consume this full-replay request, and nothing else ever
      // clears the flag: leaving it latched lets a later scoped run satisfy
      // `!replayFailed && requestedFullReplay` and clear a parity witness that
      // no full pass ever re-covered.
      progress.requestedFullReplay = false;
      if (droppedProviders) this.#bumpRevision();
      return Promise.resolve(Object.freeze({ requested: 0, failed: 0 }));
    }
    progress.peerWorklist.beginRun();
    progress.token += 1;
    const token = progress.token;
    progress.active = true;
    // One bump publishes both the drop and the run: a second one only costs
    // every racing status read a durable re-read and a transient all-null
    // parity projection.
    this.#bumpRevision();
    const run = this.#execute(input, progress, token);
    progress.completion = run;
    return run;
  }

  async #execute(
    input: Rfc64CatalogReplayRecoveryCommandV1,
    progress: ReplayProgressV1<Target>,
    token: number,
  ): Promise<Readonly<Rfc64CatalogReplayRecoveryResultV1>> {
    let requested = 0;
    let failed = 0;
    let providerFailures = 0;
    /**
     * Peers this pass queued and never heard an answer from -- a failed dial
     * or a local precondition. Distinct from `providerFailures`, which is
     * provider evidence only: both leave a peer's earlier promises unre-heard,
     * which is what the snapshot-replacement decision below turns on.
     */
    let unansweredPeers = 0;
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
              if (completion.status === 'local-unavailable') {
                // A local fault is not provider evidence: it may neither
                // attribute a failure to this peer nor clear the attribution an
                // earlier provider failure recorded.
                failed += 1;
                unansweredPeers += 1;
                return;
              }
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
                providerFailures += 1;
                unansweredPeers += 1;
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
        const promisedOverflowed = promised.length
          > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1;
        const parityFailed = promisedOverflowed
          || await this.#ports.parityFailed(input.contextGraphId, promised);
        if (requested > 0) {
          // Replacement discards every promise this pass did not re-hear, so
          // it needs more than the right to CLEAR a witness.
          // `requestedFullReplay` only says the pass QUEUED every connected
          // peer, and clearing is deliberately tolerant of a retained provider
          // that never answered -- replacing a promise snapshot is not, because
          // that peer's earlier promised head can still be durable and
          // unapplied, and dropping it reports the very zero this snapshot
          // exists to prevent. A pass that lost an answer may only ADD.
          const replacesSnapshot = progress.requestedFullReplay && unansweredPeers === 0;
          if (promisedOverflowed) {
            progress.promisedTargets = null;
          } else if (replacesSnapshot || progress.promisedTargets === null) {
            progress.promisedTargets = Object.freeze([...promised]);
          } else {
            const merged = new Map<string, Target>();
            for (const target of progress.promisedTargets) {
              merged.set(this.#ports.targetIdentity(target), target);
            }
            for (const target of promised) {
              merged.set(this.#ports.targetIdentity(target), target);
            }
            progress.promisedTargets = merged.size
              > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
              ? null
              : Object.freeze([...merged.values()]);
            if (progress.promisedTargets === null) requiresFullReplay = true;
          }
        }
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
      // ONE two-sided corroboration contract; the settle block below is its
      // other half and the two may not be read apart. `requested` counts only
      // providers that answered `completed`, so it is the sole positive
      // evidence that anything about this node's applied rows was checked.
      //   CLEAR side (here): a pass that corroborated nothing may not clear a
      //   witness, and neither may a pass that produced new evidence of its
      //   own -- `requiresFullReplay` covers parity failure, worklist
      //   exhaustion and attribution overflow. A retained provider failure is
      //   attributed, retried and reported through `unresolvedPeerCount`; on
      //   its own it must NOT veto the clear, or one connected node that never
      //   answers pins `requiresFullReplay` forever.
      //   SET side (settle block): the same `requested === 0` pass must also
      //   RAISE the uncorroborated state, because an empty manifest set makes
      //   the parity predicate vacuously true. Narrowing only the clear side
      //   would leave "nothing was verified" reported as "every provider
      //   agrees".
      replayFailed = requiresFullReplay || requested === 0;
      return Object.freeze({ requested, failed });
    } catch {
      requiresFullReplay = true;
      failed += 1;
      return Object.freeze({ requested, failed });
    } finally {
      const current = this.#byContextGraph.get(input.contextGraphId);
      if (current === progress && current.token === token) {
        const wasFullPass = current.requestedFullReplay;
        current.active = false;
        // Only evidence that applied rows may be missing (parity, worklist or
        // attribution overflow) fails the Context Graph. A provider that could
        // not be replayed from stays retained for retry and is reported on its
        // own; it says nothing about this node's applied state.
        if (requiresFullReplay) current.requiresFullReplay = true;
        if (!replayFailed && wasFullPass) current.requiresFullReplay = false;
        current.requestedFullReplay = false;
        // SET side of the corroboration contract computed above: a full pass
        // that reached no provider at all settles as uncorroborated, never as
        // a clean Context Graph. Deliberately asymmetric -- raising it needs a
        // full pass, clearing it needs only one answered replay: the claim
        // being retracted is "nothing at all answered", which a single
        // corroborated scoped replay already refutes, and a sticky-until-full-
        // pass rule would report a node that is actively and successfully
        // replaying as unknown-freshness. Peers that answered `not-provider`
        // are an authoritative negative from a reachable peer, not absence of
        // evidence, so they alone never raise it.
        // In-memory only, like `requiresFullReplay` before it: a policy-digest
        // rotation, `clear()` or a process restart drops it (see
        // `#progressFor`). The next full connected-peers pass re-raises it, and
        // until then `unresolvedPeerCount` reads as unknown rather than zero.
        // The RAISE is gated on the COMMAND KIND, not on `wasFullPass`.
        // `requestedFullReplay` is set only when the pass managed to queue every
        // connected peer, so it encodes the right to CLEAR a witness. Reusing it
        // here would withhold the DUTY to raise one in exactly the case that most
        // deserves it: a full-connected-peers pass that could not even queue every
        // peer AND had every dial fail has `requested === 0`, no `#overflowed`
        // (seedBounded defers rather than overflowing) and `#pending <= 64`, so no
        // `requiresFullReplay` either -- it would settle a Context Graph with
        // applied heads as `complete` having corroborated nothing. Incomplete
        // coverage plus zero corroboration is MORE reason to report unverified,
        // not less. The two directions are opposites and must not share a flag.
        const wasConnectedPeerPass = input.kind === 'full-connected-peers';
        if (requested > 0) current.unverified = false;
        else if (wasConnectedPeerPass && providerFailures > 0) current.unverified = true;
        current.completion = null;
        current.peerWorklist.settleOverflow();
        this.#bumpRevision();
      }
    }
  }

  /**
   * Replay evidence is process-local. A policy-digest rotation replaces the
   * entry, `clear()`/`reset()` drop it, and a restart starts empty, so both
   * `requiresFullReplay` and `unverified` evaporate at those boundaries -- as
   * they always have. Recovery is by re-derivation, not by persistence: the
   * connected-peers pass that runs on every authority accept/refresh re-raises
   * whichever state still holds. The two boundaries are NOT equally covered:
   * after a restart no entry exists, so the projection reports
   * `unresolvedReplayPeers` as unknown until that pass runs, but a digest
   * rotation constructs a live entry here, so it reports a real `0` -- it
   * evaporates the witness and shows no unknown signal at all.
   *
   * The limitation this leaves is deliberate and NOT closed by deriving
   * `failed` in `status()`: deriving a value inside an entry that no longer
   * exists derives nothing. A fleet roll restarts every node, so a Context
   * Graph carrying a witness at roll time comes back reporting clean until its
   * first pass; a policy rotation is the same shape, since rotating a policy
   * does not make unverified rows verified. Closing it needs the witness to be
   * durable, which is a persisted-record change, not a hotfix.
   */
  #progressFor(contextGraphId: string, policyDigest: string): ReplayProgressV1<Target> {
    let progress = this.#byContextGraph.get(contextGraphId);
    if (progress === undefined || progress.policyDigest !== policyDigest) {
      progress = {
        policyDigest,
        peerWorklist: new Rfc64CatalogReplayPeerWorklistV1(),
        unresolvedPeers: new Map(),
        requiresFullReplay: false,
        requestedFullReplay: false,
        token: 0,
        active: false,
        unverified: false,
        promisedTargets: null,
        completion: null,
      };
      this.#byContextGraph.set(contextGraphId, progress);
    }
    return progress;
  }

  /**
   * A retained provider that is no longer connected cannot be replayed from:
   * re-seeding it only burns worklist budget on a dead dial. Its reconnect
   * raises a fresh connection demand, so dropping it here forfeits no retry.
   * Scoped runs carry no connectivity evidence and keep every retained
   * provider. Dropping attribution is never evidence about applied rows, so a
   * witness the dropped provider's promised head raised is not dropped with
   * it: that head stays an operational target until it is applied or fails.
   */
  #dropDisconnectedUnresolvedPeers(
    progress: ReplayProgressV1<Target>,
    connectedPeerIds: readonly string[],
  ): boolean {
    if (progress.unresolvedPeers.size === 0) return false;
    const connected = new Set(connectedPeerIds);
    let dropped = false;
    // Deleting the current entry mid-iteration is well-defined for a Map.
    for (const peerId of progress.unresolvedPeers.keys()) {
      if (connected.has(peerId)) continue;
      progress.unresolvedPeers.delete(peerId);
      // An earlier request may have queued this peer and then short-circuited
      // on an in-flight completion. Leaving that demand queued dials the dead
      // provider anyway and re-attributes the failure just dropped.
      progress.peerWorklist.discard(peerId);
      dropped = true;
    }
    return dropped;
  }

  /**
   * Retained providers are retried under every command kind, but only while
   * their bounded retry budget lasts. Without that bound a full set of dead
   * providers consumes the whole per-run demand budget on every scoped run,
   * and one reconnect arriving mid-run then exhausts the worklist into a
   * spurious full-replay witness. A provider that exhausts its budget stays
   * attributed and reported, and this is the only seeding it loses: a full
   * pass still dials it when it is inside that pass's own connected-peer set,
   * and its next connection raises a fresh demand, which is seeded directly.
   * `maxSeeds` additionally floors how much of the worklist a full pass may
   * spend here, so a saturated attribution set can never starve the connected
   * fill outright.
   */
  #seedRetainedProviders(
    progress: ReplayProgressV1<Target>,
    maxSeeds = Number.POSITIVE_INFINITY,
  ): void {
    let seeded = 0;
    for (const [peerId, failures] of progress.unresolvedPeers) {
      if (seeded >= maxSeeds) break;
      if (failures >= MAX_RETAINED_REPLAY_RETRIES_V1) continue;
      if (progress.peerWorklist.seedBounded(peerId)) seeded += 1;
    }
  }

  /** Retain bounded attribution; overflow survives as a full-replay witness. */
  #retainPeerFailure(progress: ReplayProgressV1<Target>, peerId: string): boolean {
    const failures = progress.unresolvedPeers.get(peerId);
    if (failures !== undefined) {
      progress.unresolvedPeers.set(peerId, failures + 1);
      return true;
    }
    if (progress.unresolvedPeers.size < MAX_UNRESOLVED_PEERS_V1) {
      progress.unresolvedPeers.set(peerId, 1);
      return true;
    }
    progress.requiresFullReplay = true;
    return false;
  }

  #bumpRevision(): void {
    this.#revision += 1;
  }
}
