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
 *
 * Nor is a "no" given while the graph's RFC-64 authority is not in place on
 * this node a refusal: the node's log says what the subscription waits for,
 * and says so again when the wait is over and the subscription is made.
 */

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import { sharedMemoryAuthorityRecheckOf } from '../gossip-session.js';
import { UnansweredAuthorityObservation } from './context-graph-authority/unanswered-authority-read.js';
import {
  describeSharedMemoryAuthorityWait,
  SharedMemoryAuthorityWaitObservation,
  sharedMemoryAuthorityWaitsOf,
} from './shared-memory-authority-wait.js';
import { describeUnansweredAuthorityCheck } from './unanswered-authority-recheck.js';

export class SharedMemoryGossipAuthorityRead {
  readonly #read: UnansweredAuthorityObservation;
  readonly #wait: SharedMemoryAuthorityWaitObservation;
  /** Whether the graph's member subscription was wanted when the check began. */
  #subscribedAtCheck = false;

  constructor(
    private readonly contextGraphId: string,
    /** Whether the graph's member subscription is wanted at the time of the call. */
    private readonly memberSubscribed: () => boolean,
  ) {
    this.#read = new UnansweredAuthorityObservation(contextGraphId);
    this.#wait = new SharedMemoryAuthorityWaitObservation(contextGraphId);
  }

  /**
   * Run the authority check so that a chain read without an answer, and a
   * "no" that waits for the graph's authority, are noticed. Returns exactly
   * what the check returns: awaiting it through here takes no more turns than
   * awaiting it directly.
   */
  run<T>(check: () => T): T {
    // Taken before the chain read: a member subscription withdrawn while the
    // read is out must not make this pass look like one that held none.
    this.#subscribedAtCheck = this.memberSubscribed();
    return this.#read.run(() => this.#wait.run(check));
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
    /** Reconcile the graph's subscription again. */
    askAgain(): void;
  }): boolean {
    const recheck = sharedMemoryAuthorityRecheckOf(pass.session);
    const unanswered = this.#read.unanswered;
    if (pass.canUseSharedMemory || unanswered === undefined) {
      recheck.settle(this.contextGraphId);
      return false;
    }
    const subscribed = this.#subscribedAtCheck;
    const unansweredChecks = recheck.defer(this.contextGraphId, () => {
      // The repeat stands in for this pass. A member subscription that was
      // withdrawn since the check began has nothing left to decide, so the
      // graph is settled: a later subscription starts counting from one.
      if (subscribed && !this.memberSubscribed()) {
        recheck.settle(this.contextGraphId);
        return;
      }
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

  /**
   * Log an answered check as the pass acts on it. A "no" that waits for the
   * graph's authority is said at info, and at debug when repeated; any other
   * "no" is a refusal and stays a warning. A "yes" after a wait says the wait
   * is over. Nothing is logged for a "yes" without one.
   */
  logAnswer(pass: {
    /** The gossip session the pass runs for. Its waits end with it. */
    readonly session: object;
    readonly canUseSharedMemory: boolean;
    /** Whether the session holds the member subscription's handler now. */
    readonly isRegistered: boolean;
    readonly log: Pick<Logger, 'info' | 'debug' | 'warn'>;
    readonly ctx: OperationContext;
  }): void {
    const waits = sharedMemoryAuthorityWaitsOf(pass.session);
    const subject = `SWM gossip subscription for "${this.contextGraphId}"`;
    if (pass.canUseSharedMemory) {
      const waited = waits.settle(this.contextGraphId);
      if (waited === undefined) return;
      pass.log.info(pass.ctx, `${subject} ${
        pass.isRegistered ? 'is in place' : 'made'
      } after waiting for ${waited.waitingFor}`);
      return;
    }
    const wait = this.#wait.wait;
    if (wait === undefined) {
      waits.settle(this.contextGraphId);
      pass.log.warn(pass.ctx, pass.isRegistered
        ? `SWM gossip unsubscribed for "${this.contextGraphId}": local node is no longer authorized`
        : `SWM gossip subscription denied for "${this.contextGraphId}": local node is not authorized`);
      return;
    }
    pass.log[waits.wait(this.contextGraphId, wait)](pass.ctx, `${subject} waits for ${
      describeSharedMemoryAuthorityWait(wait)
    }; ${pass.isRegistered ? 'unsubscribed until then' : 'not subscribed yet'}`);
  }
}
