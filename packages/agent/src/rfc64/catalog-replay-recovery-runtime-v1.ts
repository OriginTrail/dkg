// SPDX-License-Identifier: Apache-2.0
import { Rfc64CatalogReplayPeerWorklistV1 } from './catalog-replay-peer-worklist-v1.js';

import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';
import { RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1 } from './public-catalog-receiver-v1.js';

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

/** Completeness custody held until the connection owner permits execution. */
export interface Rfc64CatalogReplayPeerReservationV1 extends Rfc64CatalogReplayPeerFenceLeaseV1 {
  admit(): void;
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

export type Rfc64CatalogReplayRecoveryRequestV1 = Readonly<
  | { kind: 'full-connected-peers' }
  | { kind: 'pending-recovery' }
  | { kind: 'connection-demand'; demand: Rfc64CatalogReplayPeerDemandV1 }
>;

/** Closed runtime commands; peer seeding and full-replay evidence cannot diverge. */
export type Rfc64CatalogReplayRecoveryCommandV1 = Readonly<{
  readonly contextGraphId: string;
  readonly policyDigest: string;
  /** Lifecycle owner for peer transport, receiver drain, and parity handoff. */
  readonly signal?: AbortSignal;
} & (Exclude<Rfc64CatalogReplayRecoveryRequestV1, { kind: 'full-connected-peers' }>
  | { kind: 'full-connected-peers'; connectedPeerIds: readonly string[] })>;

export interface Rfc64CatalogReplayRecoveryPortsV1<Target> {
  requestPeer(
    contextGraphId: string,
    peerId: string,
    signal?: AbortSignal,
  ): Promise<Rfc64CatalogReplayPeerResultV1<Target>>;
  /**
   * Resolve once THIS context graph's admitted announcements have drained.
   * Named for its scope on purpose: a node-wide wait satisfies the same
   * signature, and wiring one in would let any other graph's work hold this
   * graph's pass (and its replay-active flag) open again.
   *
   * The wait is BOUNDED by the caller (see `idleDrainBudgetMs`): this pass runs
   * inside the single-flight authority refresh, so parking here forever also
   * withholds every admission queued behind that refresh.
   */
  whenReceiverIdleForContextGraph(
    contextGraphId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Resolve after `ms`, for the idle-drain budget. Optional: omitted, a real
   * unref'd timer is used, so the budget always applies. Injected so tests
   * exercise it deterministically instead of by elapsed time.
   */
  sleep?(ms: number): Promise<void>;
  /**
   * Report a spent idle-drain budget. Without it the pass fails closed
   * silently and an operator sees the full replay without its cause.
   */
  warn?(message: string): void;
  targetIdentity(target: Target): string;
  parityFailed(contextGraphId: string, targets: readonly Target[]): Promise<boolean>;
  /**
   * Drop every promise a newer promise for the same catalog scope supersedes,
   * keeping a same-version fork intact: that disagreement is evidence the
   * projection must still see. It bounds a merged snapshot by live scopes
   * instead of by version history. Optional, because the runtime cannot rank
   * opaque targets itself; a port that omits it keeps the merged set whole.
   */
  pruneSupersededTargets?(targets: readonly Target[]): readonly Target[];
}

/**
 * How long one pass waits for this graph's admitted announcements to drain.
 *
 * A drain that never completes used to hang the pass forever. That wait is not
 * self-contained: `requestRfc64CatalogHeadReplaysFromConnectedPeersV1` is
 * awaited inside the single-flight RFC-64 authority refresh, so a parked pass
 * also holds every admission queued behind that refresh — including the
 * finalized-private catalog placement a confirmed VM publish waits on. One
 * stuck graph therefore stalled unrelated publishes indefinitely.
 *
 * Exceeding the budget reports unverified freshness and retains promises;
 * unlike worklist exhaustion, it provides no evidence that rows are missing.
 * It never reports parity it has not seen.
 *
 * DERIVED, never a bare number: at exactly the receiver's maximum admission
 * deferral window this budget is a tie, and one lawfully-deferring task — a
 * task waiting on the process-wide finalized chain-read lane, which under a
 * contended RPC budget is the expected state — defeats it every single time.
 * Keeping the factor here means the two cannot silently drift apart.
 */
export const RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1 =
  RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1 * 2;

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


/** Recovery owns expected generations, evidence and observation as one pass. */
class FullReplayPassV1<Target> {
  readonly #expected = new Map<string, { generation: number; replayed: boolean }>();
  targets: readonly Target[] | null = Object.freeze([]);
  replacesSnapshot = true;
  unanswered = false;
  constructor(readonly merge: (left: readonly Target[], right: readonly Target[]) => readonly Target[]) {}

  include(demands: readonly (Rfc64CatalogReplayPeerDemandV1 & { staged: boolean })[], prior: readonly Target[] | null, received: readonly Target[]): boolean {
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
    this.#retain(received);
    return true;
  }
  replace(demand: Rfc64CatalogReplayPeerDemandV1): void {
    if (this.#expected.has(demand.peerId)) this.#expected.set(demand.peerId, { generation: demand.generation, replayed: false });
  }
  cancelled(demand: Rfc64CatalogReplayPeerDemandV1): boolean {
    const expected = this.#expected.get(demand.peerId);
    return expected?.generation === demand.generation && !expected.replayed;
  }
  record(demand: Rfc64CatalogReplayPeerDemandV1, targets: readonly Target[], unanswered: boolean): void {
    const expected = this.#expected.get(demand.peerId);
    if (expected !== undefined && demand.generation >= expected.generation) expected.replayed = true;
    this.unanswered ||= unanswered;
    // Retain immediately after the provider response, BEFORE receiver drain.
    this.#retain(targets);
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

interface ReplayProgressV1<Target> {
  readonly policyDigest: string;
  revisionToken: object;
  readonly peerWorklist: Rfc64CatalogReplayPeerWorklistV1;
  fullPass: FullReplayPassV1<Target> | null;
  received: readonly Target[];
  /**
   * Provider-specific failures survive later scoped connection runs, each with
   * its consecutive-failure count so retries stay bounded.
   */
  readonly unresolvedPeers: Map<string, number>;
  /** Unattributed parity/overflow failures require one successful full pass. */
  requiresFullReplay: boolean;
  token: number;
  active: boolean;
  /** The last provider evidence has not yet corroborated applied rows. */
  unverified: boolean;
  /**
   * Bounded provider promises retained for the operational completeness
   * projection. A complete connected-peer pass replaces the snapshot; scoped
   * recovery can only add evidence until another complete pass supersedes it.
   * `null` means no bounded authoritative snapshot is available.
   *
   * Observed runs settle their final parity set. A receiver wait that times
   * out also retains its manifest conservatively beside unverified status,
   * so a later part cannot forget advertised but unchecked heads.
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

  /** Stable across other graphs; changes on this graph's replay transitions. */
  revisionForContextGraph(contextGraphId: string): object | undefined {
    return this.#byContextGraph.get(contextGraphId)?.revisionToken;
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

  markPeerPending(contextGraphId: string, policyDigest: string, peerId: string):
  Rfc64CatalogReplayPeerFenceLeaseV1 | null {
    const reservation = this.reservePeer(contextGraphId, policyDigest, peerId);
    reservation?.admit();
    return reservation;
  }

  reservePeer(contextGraphId: string, policyDigest: string, peerId: string):
  Rfc64CatalogReplayPeerReservationV1 | null {
    const progress = this.#progressFor(contextGraphId, policyDigest);
    const lease = progress.peerWorklist.reserve(peerId);
    if (lease === null) return null;
    progress.fullPass?.replace(lease);
    if (!progress.active) { progress.active = true; this.#bumpRevision(progress); }
    let released = false;
    return Object.freeze({
      peerId: lease.peerId, generation: lease.generation,
      admit: () => { if (!released) lease.admit(); },
      release: () => {
        if (released) return;
        released = true;
        if (progress.fullPass?.cancelled(lease)) progress.fullPass = null;
        lease.release();
        if (this.#byContextGraph.get(contextGraphId) !== progress) return;
        if (!progress.peerWorklist.hasPending && !progress.peerWorklist.hasStaged
          && progress.completion === null && progress.active) {
          progress.active = false;
          this.#bumpRevision(progress);
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
      // A pass that could not queue every peer it was handed is not a full
      // pass and may not clear a witness. It is not evidence of missing rows
      // either, so it must not raise one. Staged peers retain exact coverage
      // until their connection owner permits execution; retained providers
      // crowding out the fill withhold entitlement for bounded retries.
      const coverage = connectedPeers.map(peer => {
        const existing = progress.peerWorklist.generation(peer);
        if (existing !== null) return existing;
        return progress.peerWorklist.seedBounded(peer) ? progress.peerWorklist.generation(peer) : null;
      });
      if (coverage.some(demand => demand === null)) progress.fullPass = null;
      else {
        progress.fullPass ??= new FullReplayPassV1((left, right) => this.#mergePromises(left, right));
        if (!progress.fullPass.include(coverage.filter(demand => demand !== null), progress.promisedTargets, progress.received)) progress.fullPass = null;
      }
    } else {
      if (input.kind === 'connection-demand') progress.peerWorklist.seedDemand(input.demand);
      this.#seedRetainedProviders(progress);
    }
    // A drained worklist can still have an in-flight provider/parity pass.
    if (progress.completion !== null) {
      if (droppedProviders) this.#bumpRevision(progress);
      return progress.completion;
    }
    if (!progress.peerWorklist.hasPending) {
      // Only staged generations can carry coverage into a later connection
      // run. An empty request without that custody cannot donate entitlement.
      if (progress.fullPass?.covered) progress.fullPass = null;
      if (droppedProviders) this.#bumpRevision(progress);
      return Promise.resolve(Object.freeze({ requested: 0, failed: 0 }));
    }
    progress.peerWorklist.beginRun();
    progress.received = [];
    progress.token += 1;
    const token = progress.token;
    progress.active = true;
    // One bump publishes both the drop and the run: a second one only costs
    // every racing status read a durable re-read and a transient all-null
    // parity projection.
    this.#bumpRevision(progress);
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
     * which is what the settle-time snapshot-replacement decision turns on.
     */
    let unansweredPeers = 0;
    /**
     * The promise set of the last parity read, recorded only once the run has
     * confirmed that no joined request left a peer queued. Until then a joining
     * full pass can still hand this run its entitlement and its peers, so no
     * earlier iteration's set may decide the snapshot.
     */
    let coveredPromised: readonly Target[] | null = null;
    let replayFailed = true;
    let requiresFullReplay = false;
    // Unobserved receiver/parity work cannot clear either freshness witness.
    let drainUnobserved = false;
    let received: readonly Target[] = [];
    try {
      input.signal?.throwIfAborted();
      for (;;) {
        const replayDemands = progress.peerWorklist.drain();
        await Promise.all(replayDemands.map(async (demand) => {
          const { peerId } = demand;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              input.signal?.throwIfAborted();
              const completion = input.signal === undefined
                ? await this.#ports.requestPeer(input.contextGraphId, peerId)
                : await this.#ports.requestPeer(input.contextGraphId, peerId, input.signal);
              input.signal?.throwIfAborted();
              if (completion.status === 'local-unavailable') {
                // A local fault is not provider evidence: it may neither
                // attribute a failure to this peer nor clear the attribution an
                // earlier provider failure recorded.
                failed += 1;
                unansweredPeers += 1;
                progress.fullPass?.record(demand, [], true);
                return;
              }
              progress.unresolvedPeers.delete(peerId);
              if (completion.status === 'completed') {
                received = this.#mergePromises(received, completion.targets);
                progress.received = received;
                drainUnobserved = true;
                progress.fullPass?.record(demand, completion.targets, false);
                requested += 1;
              } else progress.fullPass?.record(demand, [], false);
              return;
            } catch (error) {
              if (input.signal?.aborted) throw input.signal.reason ?? error;
              if (attempt === 1) {
                if (!this.#retainPeerFailure(progress, peerId)) requiresFullReplay = true;
                failed += 1;
                providerFailures += 1;
                unansweredPeers += 1;
                progress.fullPass?.record(demand, [], true);
              }
            }
          }
        }));
        // Completion-capable provider responses are returned only after every
        // promised announcement is synchronously admitted at this receiver.
        // Scoped to THIS context graph: waiting for an unrelated graph to drain
        // would hold this pass open, latching its replay-active flag and
        // withholding this graph's catalog parity for as long as that lasts.
        // The announcements admitted above still take their turn behind other
        // graphs' tasks for the receiver's shared slots.
        input.signal?.throwIfAborted();
        const drained = await this.#drainedWithinBudget(input.contextGraphId, input.signal);
        input.signal?.throwIfAborted();
        if (!drained) {
          // Budget spent without observing the drain. This says only that
          // parity was NOT OBSERVED; it is not evidence that the retained
          // heads are wrong.
          //
          // Demanding a full replay here is a positive feedback loop, measured
          // on the devnet: the budget expires, every retained head is
          // re-announced at once, the receiver cannot go idle within the next
          // budget, and it expires again. Worse, `requiresFullReplay` is what
          // the status projection turns into `catalog-replay-incomplete` and
          // thence `phase: 'blocked'`, which is a HARDER verdict than "not yet
          // verified" and is exactly what the receiver reported.
          //
          // So: no full replay, no `failed`. The worklist is retained and the
          // next pass re-arms. The corroboration contract still holds — this
          // pass may not CLEAR a witness, because it observed nothing.
          this.#ports.warn?.(
            `RFC-64 catalog replay drain for ${input.contextGraphId} exceeded ` +
            `${RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1}ms; reporting the pass as ` +
            'UNVERIFIED and retaining its worklist. Parity was not observed; the retained ' +
            'heads are not presumed wrong, and no full replay is demanded.',
          );
          drainUnobserved = true;
          break;
        }
        if (progress.peerWorklist.exhausted) {
          requiresFullReplay = true;
          failed += 1;
          break;
        }
        if (progress.peerWorklist.hasPending) continue;

        const promised = progress.fullPass?.targets === null ? null
          : this.#mergePromises(progress.fullPass?.targets ?? [], received);
        input.signal?.throwIfAborted();
        const parityFailed = promised === null || promised.length
          > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
          || await this.#ports.parityFailed(input.contextGraphId, promised);
        input.signal?.throwIfAborted();
        // A reconnect generation arriving during the durable parity read owns
        // another pass. The worklist budget keeps that fence finite.
        if (progress.peerWorklist.exhausted) {
          requiresFullReplay = true;
          failed += 1;
          break;
        }
        if (progress.peerWorklist.hasPending) continue;
        // Nothing awaits between here and the settle block, so the
        // full-pass coverage it reads is the one this set was checked under.
        coveredPromised = promised;
        drainUnobserved = false;
        progress.fullPass?.observe();
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
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      requiresFullReplay = true;
      failed += 1;
      return Object.freeze({ requested, failed });
    } finally {
      const current = this.#byContextGraph.get(input.contextGraphId);
      if (current === progress && current.token === token) {
        const pass = current.fullPass;
        const wasFullPass = pass?.covered ?? false;
        current.active = current.peerWorklist.hasStaged;
        // The promise snapshot settles with the status it is read beside, under
        // this token fence and the revision bump below. A merged set past its
        // bound is capacity evidence, so it latches the witness and must also
        // stop this same settle from clearing it.
        if (
          coveredPromised !== null
          && requested > 0
          && !this.#settlePromisedTargets(
            current,
            coveredPromised,
            pass !== null && wasFullPass && pass.replacesSnapshot && !pass.unanswered && unansweredPeers === 0,
          )
        ) {
          requiresFullReplay = true;
          replayFailed = true;
        }
        if (coveredPromised === null && received.length > 0) {
          // Unobserved evidence remains a conservative operational target.
          this.#settlePromisedTargets(current, received, false);
        }
        // Only evidence that applied rows may be missing (parity, worklist or
        // attribution overflow) fails the Context Graph. A provider that could
        // not be replayed from stays retained for retry and is reported on its
        // own; it says nothing about this node's applied state.
        if (requiresFullReplay) current.requiresFullReplay = true;
        // `drainUnobserved` vetoes the CLEAR without raising a failure: the
        // pass ended without seeing this graph's admissions drain, so whatever
        // witness was standing must keep standing.
        if (!replayFailed && !drainUnobserved && wasFullPass) current.requiresFullReplay = false;
        if (wasFullPass && !drainUnobserved) current.fullPass = null;
        // Full commands with failed dials and no corroborating provider raise
        // unknown freshness even when bounded admission could not grant coverage.
        // A drained scoped response can retract "nothing answered"; it cannot
        // clear missing-row evidence without the full pass's observed generations.
        // Policy rotation, clear() and reset() discard process-local evidence.
        const wasConnectedPeerPass = input.kind === 'full-connected-peers';
        // A pass whose drain was never observed has not corroborated this
        // node's applied rows, whatever individual providers answered, so it
        // may not clear the uncorroborated witness either.
        if (requested > 0 && !drainUnobserved) current.unverified = false;
        else if (drainUnobserved) current.unverified = true;
        else if (wasConnectedPeerPass && providerFailures > 0) current.unverified = true;
        current.received = [];
        current.completion = null;
        current.peerWorklist.settleOverflow();
        this.#bumpRevision(current);
      }
    }
  }

  /**
   * Settle the retained promise snapshot from a covered run's promise set.
   * Returns false when the merged snapshot outgrew its bound.
   *
   * Replacement discards every promise the run did not re-hear, so it needs
   * more than the right to CLEAR a witness. Full-pass coverage only says
   * some request covered every connected peer, and clearing is deliberately
   * tolerant of a retained provider that never answered -- replacing a
   * promise snapshot is not, because that peer's earlier promised head can
   * still be durable and unapplied, and dropping it reports the very zero this
   * snapshot exists to prevent. A run that lost an answer may only ADD.
   */
  #settlePromisedTargets(
    progress: ReplayProgressV1<Target>,
    promised: readonly Target[],
    replaces: boolean,
  ): boolean {
    if (promised.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1) {
      // This run's parity read already failed on the same overflow.
      progress.promisedTargets = null;
      return true;
    }
    if (replaces || progress.promisedTargets === null) {
      progress.promisedTargets = Object.freeze([...promised]);
      return true;
    }
    const live = this.#mergePromises(progress.promisedTargets, promised);
    if (live.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1) {
      progress.promisedTargets = null;
      return false;
    }
    progress.promisedTargets = Object.freeze([...live]);
    return true;
  }

  #mergePromises(left: readonly Target[], right: readonly Target[]): readonly Target[] {
    const exact = new Map<string, Target>();
    for (const target of [...left, ...right]) exact.set(this.#ports.targetIdentity(target), target);
    return this.#ports.pruneSupersededTargets?.([...exact.values()]) ?? [...exact.values()];
  }

  /**
   * Replay evidence is process-local and disappears on restart or policy
   * rotation. A missing failure is therefore not proof of completion. Strict
   * readiness also requires corroborated, bounded `promisedTargets`, which
   * remain null until a provider replay has reached its parity settlement.
   */
  #progressFor(contextGraphId: string, policyDigest: string): ReplayProgressV1<Target> {
    let progress = this.#byContextGraph.get(contextGraphId);
    if (progress === undefined || progress.policyDigest !== policyDigest) {
      progress = {
        policyDigest,
        revisionToken: Object.freeze({}),
        peerWorklist: new Rfc64CatalogReplayPeerWorklistV1(),
        fullPass: null,
        received: [],
        unresolvedPeers: new Map(),
        requiresFullReplay: false,
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

  /**
   * Wait for this graph's admitted announcements to drain, bounded by
   * `RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1`. Returns `false` when the
   * budget is spent first, so the caller fails the pass closed rather than
   * holding the authority-refresh single flight open forever. An abort of
   * `signal` still rejects the wait, as it did before the budget.
   */
  async #drainedWithinBudget(contextGraphId: string, signal?: AbortSignal): Promise<boolean> {
    // Always bounded, whether or not a `sleep` port is injected: a missed
    // wiring must not silently restore the unbounded park this replaced.
    const sleep = this.#ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }));
    let timedOut = false;
    const budget = sleep(RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1).then(() => {
      timedOut = true;
    });
    await Promise.race([
      signal === undefined
        ? this.#ports.whenReceiverIdleForContextGraph(contextGraphId)
        : this.#ports.whenReceiverIdleForContextGraph(contextGraphId, signal),
      budget,
    ]);
    return !timedOut;
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

  #bumpRevision(progress?: ReplayProgressV1<Target>): void {
    this.#revision += 1;
    if (progress !== undefined) progress.revisionToken = Object.freeze({});
  }
}
