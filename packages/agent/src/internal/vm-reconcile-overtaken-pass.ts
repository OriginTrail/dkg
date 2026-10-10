// SPDX-License-Identifier: Apache-2.0

/**
 * What VM reconcile scheduling makes of a pass that was overtaken.
 *
 * A pass works on the graph's subscription row, binding and cursor as they
 * were when it resolved its target, and checks at every step that they are
 * still the current ones. When they are not it stops, with the error a pass
 * also ends on at shutdown. On a running node that is not a failure of the
 * graph. Something stored the graph's row again under the pass: a subscribe
 * request for a graph the node already holds, for one, or a sync round that
 * updated the row. The work has to be done again on the row as it is now.
 *
 * Treated as a failed pass, it held the graph's live nudges until the graph's
 * turn in the periodic sweep. Asked again instead, the graph gets its next
 * pass after one delay of the wait, one graph at a time, inside the window
 * that bounds every such retry (see `vm-reconcile-local-rpc-refusal.ts`).
 */

import { VmReconcileQueueClosedError } from '../vm-reconcile-service.js';

/**
 * An automatic pass was overtaken and its graph was left waiting to be asked
 * again. The error the pass stopped on is the `cause`. Reconcile scheduling
 * tells the pass apart by class: it was reported where the graph was parked,
 * and it does not wait for the periodic sweep.
 */
export class VmReconcileOvertakenError extends Error {
  constructor(cause: unknown) {
    super('VM reconcile target changed while the pass ran', { cause });
    this.name = 'VmReconcileOvertakenError';
  }
}

/**
 * Leave a graph waiting after a pass that stopped on `error`, and say so.
 * True when the graph will be asked again shortly. False, with nothing done,
 * when the pass did not stop because its target changed, for an operator's
 * request, for a graph the node no longer reconciles (a shutdown included),
 * and when `defer` did not take the graph: the pass then ends as it always
 * did.
 */
export function askVmReconcileAgainAfterOvertakenPass(input: {
  readonly contextGraphId: string;
  readonly error: unknown;
  /** A live or periodic pass. An operator's request gets its error as it is. */
  readonly automatic: boolean;
  /**
   * Whether the node still runs the reconcile lifecycle the pass started in
   * and still selects the graph for reconciliation. Without either there is
   * nothing to ask again.
   */
  readonly stillReconciled: () => boolean;
  /** Park the graph: `VmReconcileSchedulingRuntime.deferForOvertakenPass`. */
  readonly defer: () => 'parked' | 'again' | undefined;
  readonly log: (level: 'info' | 'debug', message: string) => void;
}): boolean {
  if (!input.automatic || !(input.error instanceof VmReconcileQueueClosedError)) return false;
  if (!input.stillReconciled()) return false;
  const waiting = input.defer();
  if (waiting === undefined) return false;
  // Said where an operator sees it when a pass from elsewhere was overtaken.
  // The wait's own repeats stay at debug.
  input.log(
    waiting === 'parked' ? 'info' : 'debug',
    `VM reconcile for "${input.contextGraphId}" was overtaken by a change to the graph's `
      + 'subscription or binding; asking again shortly',
  );
  return true;
}
