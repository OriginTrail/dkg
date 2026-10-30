// SPDX-License-Identifier: Apache-2.0

// Repeats the empty-VM proof of a registered private Context Graph while an
// approved member stays unsynced.
//
// For such a graph nothing else can set `synced`: peer evidence counts only by
// its content on a private plane, and the durable plane is skipped when the
// catalog owns it. The proof ran at three points, once each: inside the subscribe
// request, when the catch-up job completed, and when the join's metadata was
// confirmed. A curator's metadata that came a few seconds late, an authority
// index one tick behind, or a slow endpoint could leave a member unsynced until
// it subscribed again, although its join was approved.
//
// So a settlement that ends unproven, for a reason a later attempt can change,
// arms one sequence for its graph. Each repeat is an ordinary settlement: the same
// proof, needing every condition, committing under the same readiness lock. The
// sequence ends when the graph is synced or no longer subscribed, when an attempt
// answers finally, when the node stops, or at its bound. A later subscribe, join
// metadata or catch-up job then starts a new one.
//
// An accepted authority for the graph runs the next attempt early, once per
// attempt. It does not start an ended sequence: that wake-up comes with every
// authority refresh of an approved graph, so the repeat would have no bound.

import type { DKGAgent } from '@origintrail-official/dkg-agent';

/** The wait before each repeat, in order: its length bounds how many a sequence makes. */
export const PRIVATE_EMPTY_VM_REPEAT_DELAYS_MS: readonly number[] = Object.freeze([
  15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000,
]);
/** No repeat starts later than this after the sequence was armed. */
export const PRIVATE_EMPTY_VM_REPEAT_WINDOW_MS = 30 * 60_000;

/** Test seam: the timers repeats are armed with. They never hold the process open. */
export const privateEmptyVmRepeatTimers = {
  set(callback: () => void, delayMs: number): unknown {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface PrivateEmptyVmRepeatOutcome {
  readonly proven: boolean;
  /** Nothing a later attempt can see changes this answer. */
  readonly final?: boolean;
}

type RepeatAttempt = () => Promise<PrivateEmptyVmRepeatOutcome>;

const sequencesByAgent = new WeakMap<DKGAgent, Map<string, PrivateEmptyVmRepeatSequence>>();

/**
 * Arm the graph's sequence after a settlement that ended unproven. A sequence
 * already armed keeps its schedule, so a stream of settlements cannot extend its
 * bound; it takes the newer attempt, whose caller is the latest to ask.
 */
export function armPrivateEmptyVmRepeat(input: {
  agent: DKGAgent;
  contextGraphId: string;
  attempt: RepeatAttempt;
}): void {
  const { agent, contextGraphId, attempt } = input;
  let sequences = sequencesByAgent.get(agent);
  if (sequences === undefined) {
    sequences = new Map();
    sequencesByAgent.set(agent, sequences);
  }
  const armed = sequences.get(contextGraphId);
  if (armed !== undefined) {
    armed.useAttempt(attempt);
    return;
  }
  if (agent.node?.stopSignal?.aborted === true) return;
  const sequence = new PrivateEmptyVmRepeatSequence(agent, contextGraphId, attempt, sequences);
  sequences.set(contextGraphId, sequence);
  sequence.start();
}

/** The graph's authority was accepted: what the armed repeat waited for may be there now. */
export function expeditePrivateEmptyVmRepeat(agent: DKGAgent, contextGraphId: string): void {
  sequencesByAgent.get(agent)?.get(contextGraphId)?.expedite();
}

class PrivateEmptyVmRepeatSequence {
  readonly #agent: DKGAgent;
  readonly #contextGraphId: string;
  readonly #sequences: Map<string, PrivateEmptyVmRepeatSequence>;
  readonly #startedAt = Date.now();
  readonly #stopSignal: AbortSignal | undefined;
  readonly #onStop = (): void => this.#end();
  #attempt: RepeatAttempt;
  #repeatsRun = 0;
  #timer: unknown;
  #ended = false;
  /** The armed repeat was already started early once: the next one keeps its delay. */
  #expedited = false;

  constructor(
    agent: DKGAgent,
    contextGraphId: string,
    attempt: RepeatAttempt,
    sequences: Map<string, PrivateEmptyVmRepeatSequence>,
  ) {
    this.#agent = agent;
    this.#contextGraphId = contextGraphId;
    this.#attempt = attempt;
    this.#sequences = sequences;
    this.#stopSignal = agent.node?.stopSignal;
  }

  start(): void {
    this.#stopSignal?.addEventListener('abort', this.#onStop, { once: true });
    this.#armNext();
  }

  useAttempt(attempt: RepeatAttempt): void {
    this.#attempt = attempt;
  }

  expedite(): void {
    if (this.#ended || this.#timer === undefined || this.#expedited) return;
    privateEmptyVmRepeatTimers.clear(this.#timer);
    this.#timer = undefined;
    this.#expedited = true;
    void this.#repeat();
  }

  #armNext(): void {
    const delayMs = PRIVATE_EMPTY_VM_REPEAT_DELAYS_MS[this.#repeatsRun];
    if (delayMs === undefined || Date.now() - this.#startedAt + delayMs > PRIVATE_EMPTY_VM_REPEAT_WINDOW_MS) {
      console.info(
        `[private-empty-vm] "${this.#contextGraphId}" is still not proven after ${this.#repeatsRun} repeated `
          + 'attempt(s); subscribe again to start over',
      );
      this.#end();
      return;
    }
    this.#timer = privateEmptyVmRepeatTimers.set(() => {
      this.#timer = undefined;
      this.#expedited = false;
      void this.#repeat();
    }, delayMs);
  }

  #wanted(): boolean {
    const subscription = this.#agent.getSubscribedContextGraphs().get(this.#contextGraphId);
    return subscription?.subscribed === true && subscription.synced !== true;
  }

  async #repeat(): Promise<void> {
    if (this.#ended) return;
    try {
      if (!this.#wanted()) {
        this.#end();
        return;
      }
      this.#repeatsRun += 1;
      const outcome = await this.#attempt();
      if (this.#ended) return;
      if (outcome.proven || outcome.final === true || !this.#wanted()) {
        this.#end();
        return;
      }
      this.#armNext();
    } catch (err) {
      console.warn(
        `[private-empty-vm] repeat for "${this.#contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.#end();
    }
  }

  #end(): void {
    this.#ended = true;
    if (this.#timer !== undefined) privateEmptyVmRepeatTimers.clear(this.#timer);
    this.#timer = undefined;
    this.#stopSignal?.removeEventListener('abort', this.#onStop);
    if (this.#sequences.get(this.#contextGraphId) === this) this.#sequences.delete(this.#contextGraphId);
  }
}
