// SPDX-License-Identifier: Apache-2.0

/**
 * What a VM reconcile pass makes of a chain read that the node's own RPC
 * admission refused.
 *
 * The transport marks a read whose attempt never left the process: its
 * deadline ran out while it waited for local admission, or the admission
 * queue was full. That attempt asked no endpoint and no contract, so the
 * refusal says nothing about the graph, and it ends on its own once the
 * node's other reads have drained (after a start, above all). A pass that
 * ends on such a read leaves its
 * graph waiting to be asked again shortly instead of waiting for the periodic
 * sweep. So does a slice that went on without one, when asking again repeats
 * nothing the slice did (see {@link VmReconcileRefusedSliceReads}).
 *
 * Asking again is bounded twice. The wait asks one graph at a time and
 * nothing for one delay after a refused attempt, so the node starts at most
 * one such pass per delay however many graphs wait. And a graph is asked
 * again only inside a window that opens with its first refused pass: when
 * its passes are still refused after it, the sweep retries the graph as
 * before, until one of its passes succeeds without meeting a refused read.
 *
 * Only the local refusal qualifies. A read that every endpoint failed or
 * throttled was sent, and asking again within seconds repeats it against the
 * endpoints that just refused it. An answer from the chain is an answer.
 */

import { isRpcRequestGovernorQueueFullError } from '@origintrail-official/dkg-chain';

/**
 * How long after its first refused pass a graph is still asked again shortly.
 * It outlasts the stretches in which a node's own start-up reads were seen to
 * keep its background reads from being admitted: about a minute on a node
 * with few graphs (#3028), four to five on one with several hundred saved
 * subscriptions (#3118).
 */
export const VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS = 5 * 60_000;

/** Whether the node's own RPC admission refused the read, so it was never sent. */
export function isLocalRpcRefusal(error: unknown): boolean {
  return isRpcRequestGovernorQueueFullError(error);
}

function refusalMessage(refusal: unknown): string {
  return refusal instanceof Error ? refusal.message : String(refusal);
}

/**
 * An automatic pass ended on a refused read and its graph was left waiting to
 * be asked again. The refusal is the `cause` and gives the message. Reconcile
 * scheduling tells the pass apart by class: it was reported where the graph
 * was parked, and it does not wait for the periodic sweep.
 */
export class VmReconcileLocalRpcRefusalError extends Error {
  constructor(refusal: unknown) {
    super(refusalMessage(refusal), { cause: refusal });
    this.name = 'VmReconcileLocalRpcRefusalError';
  }
}

/**
 * The reads of one slice that failed where the pass goes on without them: the
 * head block, and the reads that resolve one ordinal.
 *
 * Such a slice is asked again shortly only when asking again repeats nothing
 * the slice did. That is so when it did no work: it had no head block, or
 * none of the ordinals it visited could be resolved. And it is so when the
 * ordinals it could not resolve are all that is still outstanding for the
 * graph. Otherwise the next pass reads again what this one resolved and left
 * pending for reasons of its own, and that is the periodic sweep's work, not
 * the retry of a read that was not sent.
 */
export class VmReconcileRefusedSliceReads {
  #headBlock: unknown;
  #ordinal: unknown;
  #ordinals = 0;

  /** The head-block read failed with `error`. */
  headBlockFailed(error: unknown): void {
    if (isLocalRpcRefusal(error)) this.#headBlock = error;
  }

  /** The reads that resolve one ordinal failed with `error`. */
  ordinalFailed(error: unknown): void {
    if (!isLocalRpcRefusal(error)) return;
    this.#ordinal ??= error;
    this.#ordinals += 1;
  }

  /** Whether the slice met a refused read at all, asked again for or not. */
  get met(): boolean {
    return this.#headBlock !== undefined || this.#ordinals > 0;
  }

  /**
   * The refusal to ask again for, or undefined when the slice is not asked
   * again. `visited` is how many ordinals the slice went through, and
   * `outstanding` how many the graph still has to reconcile after it.
   */
  askAgainFor(slice: { readonly visited: number; readonly outstanding: number }): unknown {
    if (this.#headBlock !== undefined) return this.#headBlock;
    // With no ordinal refused there is no refusal to return either way.
    return this.#ordinals === slice.visited || this.#ordinals === slice.outstanding
      ? this.#ordinal
      : undefined;
  }
}

/**
 * The window in which each graph is asked again shortly.
 *
 * It opens with the first pass of the graph that meets a refused read and
 * stays, open or run out, until a pass of the graph succeeds without meeting
 * one. The next refusal then opens a new one. A pass that failed for another
 * reason shows nothing about the node's RPC admission and closes nothing. So
 * a graph whose reads stay refused costs its retries once, not once per
 * sweep.
 *
 * The scheduling runtime keeps a pass that was overtaken inside the same
 * window (`vm-reconcile-overtaken-pass.ts`): it is the one bound on asking a
 * graph again shortly, whatever the reason.
 */
export class VmReconcileLocalRpcRefusalWindow {
  /** When each graph's window opened. */
  readonly #openedAt = new Map<string, number>();
  /** Graphs whose running pass met a refused read. */
  readonly #refusedPasses = new Set<string>();

  constructor(
    /**
     * Bound on graphs remembered. Past it the window that opened first is
     * forgotten, which at worst gives that graph a new one.
     */
    private readonly maxGraphs: number,
    private readonly windowMs = VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS,
  ) {}

  /**
   * The graph's running pass met a refused read, whether or not the graph is
   * asked again for it. True while the graph is inside its window, so it may
   * be asked again shortly.
   */
  refused(key: string): boolean {
    const now = Date.now();
    this.#refusedPasses.add(key);
    let openedAt = this.#openedAt.get(key);
    if (openedAt === undefined) {
      if (this.#openedAt.size >= this.maxGraphs) {
        const [first] = this.#openedAt.keys();
        if (first !== undefined) this.#openedAt.delete(first);
      }
      openedAt = now;
      this.#openedAt.set(key, openedAt);
    }
    return now - openedAt < this.windowMs;
  }

  /**
   * The pass ended. One that succeeded without meeting a refused read closes
   * the graph's window.
   */
  passEnded(key: string, succeeded: boolean): void {
    const refused = this.#refusedPasses.delete(key);
    if (succeeded && !refused) this.#openedAt.delete(key);
  }
}

/**
 * Leave a graph waiting after a pass that met `refusal`, and say so. True
 * when the graph will be asked again shortly. False, with nothing done, for
 * anything but a local refusal, for an operator's request, and when `defer`
 * did not take the graph: the pass then ends as it always did.
 */
export function askVmReconcileAgainAfterLocalRpcRefusal(input: {
  readonly contextGraphId: string;
  readonly refusal: unknown;
  /** A live or periodic pass. An operator's request gets its result as it is. */
  readonly automatic: boolean;
  /** Park the graph: `VmReconcileSchedulingRuntime.deferForLocalRpcRefusal`. */
  readonly defer: () => 'parked' | 'again' | undefined;
  readonly log: (level: 'info' | 'debug', message: string) => void;
}): boolean {
  if (!input.automatic || !isLocalRpcRefusal(input.refusal)) return false;
  const waiting = input.defer();
  if (waiting === undefined) return false;
  // Said where an operator sees it when the graph starts waiting, and when a
  // pass from elsewhere finds it still refused. The wait's own repeats stay
  // at debug.
  input.log(
    waiting === 'parked' ? 'info' : 'debug',
    `VM reconcile for "${input.contextGraphId}" is waiting for local RPC admission; `
      + `asking again shortly: ${refusalMessage(input.refusal)}`,
  );
  return true;
}
