// SPDX-License-Identifier: Apache-2.0

/**
 * The authority check of one shared-memory gossip reconcile.
 *
 * The check ends in a chain read. When that read gets no answer, the check
 * says "no", which is neither a grant nor a refusal: the node's own RPC budget
 * did not admit the read, or the endpoint did not reply in time. A
 * subscription this node holds then stays, one it does not hold is not made,
 * and the graph is asked again without waiting for the next event that would
 * reconcile it.
 */

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import { sharedMemoryAuthorityRecheckOf } from '../gossip-session.js';
import { UnansweredAuthorityObservation } from './context-graph-authority/unanswered-authority-read.js';
import { describeUnansweredAuthorityCheck } from './unanswered-authority-recheck.js';

export class SharedMemoryGossipAuthorityRead {
  readonly #read: UnansweredAuthorityObservation;

  constructor(private readonly contextGraphId: string) {
    this.#read = new UnansweredAuthorityObservation(contextGraphId);
  }

  /**
   * Run the authority check so that a chain read without an answer is
   * noticed. Returns exactly what the check returns: awaiting it through here
   * takes no more turns than awaiting it directly.
   */
  run<T>(check: () => T): T {
    return this.#read.run(check);
  }

  /**
   * Call with the check's result. True when the check said "no" because a
   * chain read got no answer: the graph is then queued to be asked again and
   * the pass ends, leaving the member subscription as it is. False when the
   * check was answered: nothing is left to ask and the pass goes on.
   */
  deferIfUnanswered(pass: {
    /** The gossip session the pass runs for. Its queue ends with it. */
    readonly session: object;
    readonly canUseSharedMemory: boolean;
    /** Whether the session holds the member subscription's handler now. */
    readonly isRegistered: boolean;
    readonly log: Pick<Logger, 'info' | 'debug'>;
    readonly ctx: OperationContext;
    /** Whether the graph's member subscription is wanted at the time of the call. */
    memberSubscribed(): boolean;
    /** Reconcile the graph's subscription again. */
    askAgain(): void;
  }): boolean {
    const recheck = sharedMemoryAuthorityRecheckOf(pass.session);
    const unanswered = this.#read.unanswered;
    if (pass.canUseSharedMemory || unanswered === undefined) {
      recheck.settle(this.contextGraphId);
      return false;
    }
    const subscribed = pass.memberSubscribed();
    const unansweredChecks = recheck.defer(this.contextGraphId, () => {
      // The repeat stands in for this pass. A member subscription that was
      // withdrawn in the meantime has nothing left to decide.
      if (subscribed && !pass.memberSubscribed()) return;
      pass.askAgain();
    });
    pass.log[unansweredChecks <= 1 ? 'info' : 'debug'](pass.ctx, describeUnansweredAuthorityCheck({
      subject: `SWM gossip subscription for "${this.contextGraphId}"`,
      waitingFor: 'read authority',
      read: unanswered,
      meanwhile: pass.isRegistered ? 'the subscription is kept' : 'not subscribed yet',
      unansweredChecks,
    }));
    return true;
  }
}
