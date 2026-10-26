// daemon/context-graph-readiness-repeat.ts
//
// Repeats the catch-up job of a public Context Graph, registered on chain or
// not, while a subscription has left it unproven.
//
// A subscription reports `synced` only once a catch-up job has proven its
// requested planes, and the subscribe route runs exactly one job per call. For
// such a graph the durable plane does not apply, so only shared memory can be
// proven, and for an empty graph the only proof is a round in which every
// asked peer answered empty. A single peer whose round did not complete voids
// it: a transport failure, or this node revoking its own recovery lease while
// the round ran (a receiver selection change of the graph does that). Nothing
// ran the job again, so such a subscription stayed unsynced for good. Shares
// that arrive later do not change that: root-scope shares of a
// catalog-authoritative graph come on the catalog lane, and neither that lane
// nor gossip writes readiness.
//
// So the subscribe route hands every job it starts to one repeat sequence.
// While the job, and each repeat after it, leaves such a graph unsynced, the
// sequence runs the same job again after a growing delay, with a fresh
// admission read and the same proof rules, up to a fixed number of repeats.
// The sequence alone owns the count, the timer, the caller's context and the
// cancellation; each attempt is one ordinary job. A newer subscribe call's
// sequence replaces the graph's older one, wherever that one is.
//
// A registered public graph can be left unproven the same way: its root scope
// is the catalog's, so its durable plane is not walked, and only a round of
// shared memory can prove it. A member's first job, or the job that catches up
// its subscription after a restart, can walk its peers before the node has
// accepted the graph's RFC-64 authority: the graph's selected shared-memory
// lane is not active yet, so the walk asks no peer anything, and the authority
// arrives seconds later. Or the walk runs while that authority is being put in
// place, as it is when the job's own metadata pull installs the graph's
// definition from the chain: the activation revokes the walk's recovery
// leases, so the round does not complete. Or a Core still lists the
// shared-memory copy of an asset it signed a StorageACK for, whose snapshot it
// does not hold, until the asset reaches its Verified Memory and the copy
// goes. Each of these is over seconds later, and a registered public graph is
// repeated like an unregistered one.
//
// Such a repeat has nothing to wait for once the lane is active. The job's
// own last step refreshes the graph's authority, so the lane is often active
// by the time the job settles: the repeat then runs at once instead of after
// its delay. A write that waits for the graph (`context-graph-write-readiness.ts`)
// starts an armed repeat early the same way, once the lane is active.
//
// A walk that stalls is not such a cause. Each job walks every capable peer
// and pulls the graph's shared-memory metadata from each, with further passes
// while they make progress. A job stalled when peers served it that metadata
// through the graph's lane, its walk was clean (no failed, timed-out, deferred
// or locally yielded work, and no snapshot it could not write), the walk
// stopped because a further pass made no progress (`coverage-stalled`), and no
// new shared-memory data was written from any peer. Two such jobs in a row end
// the sequence: the next one would walk the same peers again and write nothing
// more. After a restart every node of a network catches its subscriptions up
// at once, and a graph whose snapshots no job completes was otherwise pulled
// from every peer for hours. A job that reached no peer, ran before the lane
// was active, or whose work failed or was cut short is never counted as
// stalled, so the delayed repeats still cover peers and faults that pass.

import type { ContextGraphReadAuthorityDecision } from '@origintrail-official/dkg-agent';
import { selectedSharedMemoryLaneActive } from '../catchup-selected-lane.js';
import { classifyNameHashOnlyCatchup } from '../context-graph-readiness.js';
import type { ContextGraphCatchupProgressSource } from './context-graph-catchup-progress.js';
import {
  startContextGraphCatchupJob,
  type ContextGraphCatchupJobInput,
  type StartedContextGraphCatchupJob,
} from './context-graph-catchup-job.js';
import { readContextGraphSubscriptionAdmission } from './context-graph-subscription-admission.js';
import { daemonState } from './state.js';
import type { CatchupJob } from './types.js';

/**
 * Delay before each repeat, in order. Its length is the number of repeats one
 * subscribe call gets: about an hour in all, the first a few seconds after the
 * job, while a transient cause (a revoked lease, a reset stream) has passed but
 * little has had time to change.
 */
export const CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS: readonly number[] = Object.freeze([
  15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000,
]);

/** Test seam: the timers repeats are armed with. They never hold the process open. */
export const readinessRepeatTimers = {
  set(callback: () => void, delayMs: number): unknown {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A subscribe call's job input, and the request's agent, whose admission a repeat reads again. */
export type ContextGraphReadinessRepeatCaller = ContextGraphCatchupJobInput & {
  readonly requestAgentAddress: string | undefined;
};

/** The current sequence of each graph that has one. */
const sequences = new Map<string, ReadinessRepeatSequence>();

/**
 * Follow the job a subscribe call started: repeat it while it leaves the
 * graph unproven. Call it right after the mint, without an await in between,
 * so the graph's older sequence ends before anything else can run.
 */
export function followContextGraphCatchupJob(
  caller: ContextGraphReadinessRepeatCaller,
  started: StartedContextGraphCatchupJob,
): void {
  sequences.get(caller.contextGraphId)?.cancel();
  const sequence = new ReadinessRepeatSequence(caller);
  sequences.set(caller.contextGraphId, sequence);
  sequence.follow(started, caller.admissionAuthority);
}

/** End every sequence and its pending repeat: when the daemon shuts down, and between tests. */
export function cancelContextGraphReadinessRepeats(): void {
  for (const sequence of sequences.values()) sequence.cancel();
  sequences.clear();
}

/**
 * The repeats as catch-up progress (`context-graph-catchup-progress.ts`): a
 * graph with a sequence is being caught up, an attempt in flight or a repeat
 * armed, and a write that waits for it starts an armed repeat early when that
 * repeat waited only for the graph's authority (`expedite`).
 */
export const readinessRepeatProgress: ContextGraphCatchupProgressSource = Object.freeze({
  catchingUp: (contextGraphId: string) => sequences.has(contextGraphId),
  hurry: (contextGraphId: string) => sequences.get(contextGraphId)?.expedite(),
});

/**
 * Admission of a graph that repeats: a public graph, registered on chain or
 * not. A private graph has proofs of its own (the member catalog, the empty-VM
 * proof).
 */
function admitsRepeat(authority: ContextGraphReadAuthorityDecision): boolean {
  return authority.outcome === 'allowed' && authority.grantScope === 'public';
}

/**
 * The job walked its peers and it made no difference: peers served the
 * graph's shared-memory metadata through its lane, local admission deferred
 * none of the work, the walk stopped because a further pass made no progress
 * (`coverage-stalled`), and no new shared-memory data was written from any
 * peer. Progress is judged across every peer of the job, not by the one peer
 * the coverage diagnostic describes. A job that reached no peer, whose rounds
 * failed before any metadata arrived, or whose work was deferred, is not one.
 */
function stalledWithoutProgress(job: CatchupJob): boolean {
  const result = job.result;
  const sharedMemory = result?.diagnostics?.sharedMemory;
  // Only a clean walk is evidence: no peer or phase failed or timed out, local
  // admission neither deferred (the job's own count leaves out continuation
  // passes; the shared-memory diagnostic counts every one) nor yielded, and
  // every snapshot that arrived was written. Failed or interrupted work may go
  // through on a later job.
  return job.selectedLaneFoundInactive !== true
    && result?.deferredBackpressure === 0
    && sharedMemory?.deferredBackpressure === 0
    && sharedMemory.failedPeers === 0
    && sharedMemory.failedPhases === 0
    && sharedMemory.timedOutPhases === 0
    && sharedMemory.localYield !== true
    && (sharedMemory.swmCoverage?.materializationFailures ?? 0) === 0
    && sharedMemory.continuationStopReason === 'coverage-stalled'
    && sharedMemory.fetchedMetaTriples > 0
    && sharedMemory.insertedDataTriples === 0;
}

/** The repeats that follow one subscribe call's job for one graph. */
class ReadinessRepeatSequence {
  readonly #caller: ContextGraphReadinessRepeatCaller;
  /** The runner that ran the first job: a daemon that has replaced it is not the one this belongs to. */
  readonly #runner = daemonState.catchupRunner;
  #repeatsRun = 0;
  #timer: unknown;
  #ended = false;
  /** The last attempt found the graph's selected shared-memory lane not active. */
  #laneFoundInactive = false;
  /** The armed repeat follows a settled attempt, not an admission that could not be read. */
  #armedAfterAttempt = false;
  /** Attempts in a row whose walk stalled without writing anything new. */
  #stalledInARow = 0;

  constructor(caller: ContextGraphReadinessRepeatCaller) {
    this.#caller = caller;
  }

  follow(started: StartedContextGraphCatchupJob, authority: ContextGraphReadAuthorityDecision): void {
    void started.settled.then(() => this.#afterAttempt(started.job, authority));
  }

  cancel(): void {
    this.#ended = true;
    if (this.#timer !== undefined) readinessRepeatTimers.clear(this.#timer);
    this.#timer = undefined;
    if (sequences.get(this.#caller.contextGraphId) === this) sequences.delete(this.#caller.contextGraphId);
  }

  /**
   * Run the armed repeat now, when it follows an attempt that ran before the
   * graph's authority and the lane is active by now. Once per attempt: a
   * repeat armed after an unreadable admission keeps its delay, so the
   * sequence never spends its repeats faster than its attempts run.
   */
  expedite(): void {
    if (this.#ended || this.#timer === undefined || !this.#armedAfterAttempt || !this.#laneNowActive()) return;
    readinessRepeatTimers.clear(this.#timer);
    this.#timer = undefined;
    this.#armedAfterAttempt = false;
    void this.#repeat();
  }

  /** The last attempt found the graph's selected lane not active, and it is active now. */
  #laneNowActive(): boolean {
    return this.#laneFoundInactive
      && selectedSharedMemoryLaneActive(this.#caller.agent, this.#caller.contextGraphId);
  }

  /**
   * After an attempt settles: arm the next repeat while the graph is still
   * actively subscribed and unsynced, with shared memory requested and no
   * denial, unless two attempts in a row stalled without writing anything new;
   * else end.
   * A denial is not cleared by asking again, and without shared memory
   * nothing could prove an unregistered graph.
   */
  #afterAttempt(job: CatchupJob, authority: ContextGraphReadAuthorityDecision): void {
    if (this.#ended) return;
    try {
      const subscription = this.#caller.agent.getSubscribedContextGraphs().get(this.#caller.contextGraphId);
      this.#laneFoundInactive = job.selectedLaneFoundInactive === true;
      const unproven = this.#caller.includeSharedMemory
        && admitsRepeat(authority)
        && job.status !== 'denied'
        // A job that continued under another id (a resolved name) left this graph.
        && job.resolvedContextGraphId === undefined
        // Nothing under a name-hash id can be proven: holders key the graph by its cleartext id.
        && classifyNameHashOnlyCatchup(this.#caller.agent.describeContextGraphIdentity?.(this.#caller.contextGraphId)) === null
        && subscription?.subscribed === true
        && subscription.synced !== true;
      if (!unproven) {
        this.cancel();
        return;
      }
      this.#stalledInARow = stalledWithoutProgress(job) ? this.#stalledInARow + 1 : 0;
      if (this.#stalledInARow >= 2) {
        console.log(
          `[catchup] not repeating the catch-up of "${this.#caller.contextGraphId}": two jobs in a row walked `
            + 'its peers until no pass made progress and wrote nothing new, so another job would walk them '
            + 'again for nothing; subscribe again or restart to start over',
        );
        this.cancel();
        return;
      }
      this.#armNext(true);
    } catch {
      // A repeat is a convenience on top of a settled job; it must not turn
      // the job's terminal path into a failure.
      this.cancel();
    }
  }

  #armNext(afterAttempt = false): void {
    const delayMs = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[this.#repeatsRun];
    if (delayMs === undefined) {
      console.log(
        `[catchup] "${this.#caller.contextGraphId}" is still not proven synced after ${this.#repeatsRun} `
          + 'repeated catch-up job(s); subscribe again to start over',
      );
      this.cancel();
      return;
    }
    this.#armedAfterAttempt = afterAttempt;
    // The attempt ran before the graph's authority, which is in place now:
    // its own authority refresh may have put it there. Nothing to wait for.
    const dueMs = afterAttempt && this.#laneNowActive() ? 0 : delayMs;
    this.#timer = readinessRepeatTimers.set(() => {
      this.#timer = undefined;
      void this.#repeat();
    }, dueMs);
  }

  /**
   * Whether a repeat may still start a job: the daemon accepts jobs with the
   * runner that ran the first one, and the graph is still subscribed and
   * unsynced with no job in flight.
   */
  #wanted(): boolean {
    if (!daemonState.catchupAcceptingJobs || !this.#runner || daemonState.catchupRunner !== this.#runner) {
      return false;
    }
    const { agent, catchupTracker, contextGraphId } = this.#caller;
    const subscription = agent.getSubscribedContextGraphs().get(contextGraphId);
    if (subscription?.subscribed !== true || subscription.synced === true) return false;
    const latestJobId = catchupTracker.latestByContextGraph.get(contextGraphId);
    const latest = latestJobId === undefined ? undefined : catchupTracker.jobs.get(latestJobId);
    return latest?.status !== 'queued' && latest?.status !== 'running';
  }

  /** One repeat: fresh admission, then the same job. */
  async #repeat(): Promise<void> {
    if (this.#ended) return;
    this.#repeatsRun += 1;
    const caller = this.#caller;
    try {
      if (!this.#wanted()) {
        this.cancel();
        return;
      }
      const admission = await readContextGraphSubscriptionAdmission(
        caller.agent, caller.contextGraphId, caller.requestAgentAddress,
      ).catch(() => undefined);
      // A newer subscribe call may have replaced this sequence meanwhile.
      if (this.#ended) return;
      // Admission could not be read now: count the repeat and wait for the next.
      if (admission === undefined || admission.authority.outcome === 'unavailable') {
        this.#armNext();
        return;
      }
      // No await from here to the mint, as on the subscribe route.
      if (!this.#wanted() || !admitsRepeat(admission.authority)) {
        this.cancel();
        return;
      }
      console.log(
        `[catchup] repeating the catch-up of "${caller.contextGraphId}" (${this.#repeatsRun} of `
          + `${CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS.length}): the graph is not proven synced yet`
          + (this.#laneFoundInactive ? '; the last attempt ran before its RFC-64 authority was in place' : ''),
      );
      const started = startContextGraphCatchupJob({
        agent: caller.agent,
        store: caller.store,
        catchupTracker: caller.catchupTracker,
        contextGraphId: caller.contextGraphId,
        includeSharedMemory: caller.includeSharedMemory,
        callerAgentAddress: admission.callerAgentAddress,
        admissionAuthority: admission.authority,
      });
      this.follow(started, admission.authority);
    } catch (err) {
      this.cancel();
      console.error(
        `[catchup] readiness repeat for "${caller.contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
