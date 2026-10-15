// daemon/context-graph-readiness-repeat.ts
//
// Repeats the catch-up job of a public Context Graph that is not registered on
// chain, while a subscription has left it unproven.
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

import type { ContextGraphReadAuthorityDecision } from '@origintrail-official/dkg-agent';
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

/** Test seam: end every sequence. */
export function resetContextGraphReadinessRepeats(): void {
  for (const sequence of sequences.values()) sequence.cancel();
  sequences.clear();
}

/**
 * Admission of a public graph that is not registered on chain, the only kind
 * that repeats: a registered graph has its durable plane and its curator's
 * word, and a private graph has proofs of its own (the member catalog, the
 * empty-VM proof).
 */
function admitsRepeat(authority: ContextGraphReadAuthorityDecision): boolean {
  return authority.outcome === 'allowed'
    && authority.grantScope === 'public'
    && authority.registration === 'unregistered';
}

/** The repeats that follow one subscribe call's job for one graph. */
class ReadinessRepeatSequence {
  readonly #caller: ContextGraphReadinessRepeatCaller;
  /** The runner that ran the first job: a daemon that has replaced it is not the one this belongs to. */
  readonly #runner = daemonState.catchupRunner;
  #repeatsRun = 0;
  #timer: unknown;
  #ended = false;

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
   * After an attempt settles: arm the next repeat while the graph is still
   * actively subscribed and unsynced, with shared memory requested and no
   * denial; else end. A denial is not cleared by asking again, and without
   * shared memory nothing could prove an unregistered graph.
   */
  #afterAttempt(job: CatchupJob, authority: ContextGraphReadAuthorityDecision): void {
    if (this.#ended) return;
    try {
      const subscription = this.#caller.agent.getSubscribedContextGraphs().get(this.#caller.contextGraphId);
      const unproven = this.#caller.includeSharedMemory
        && admitsRepeat(authority)
        && job.status !== 'denied'
        // A job that continued under another id (a resolved name) left this graph.
        && job.resolvedContextGraphId === undefined
        && subscription?.subscribed === true
        && subscription.synced !== true;
      if (unproven) this.#armNext();
      else this.cancel();
    } catch {
      // A repeat is a convenience on top of a settled job; it must not turn
      // the job's terminal path into a failure.
      this.cancel();
    }
  }

  #armNext(): void {
    const delayMs = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[this.#repeatsRun];
    if (delayMs === undefined) {
      console.log(
        `[catchup] "${this.#caller.contextGraphId}" is still not proven synced after ${this.#repeatsRun} `
          + 'repeated catch-up job(s); subscribe again to start over',
      );
      this.cancel();
      return;
    }
    this.#timer = readinessRepeatTimers.set(() => {
      this.#timer = undefined;
      void this.#repeat();
    }, delayMs);
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
          + `${CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS.length}): the graph is not proven synced yet`,
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
