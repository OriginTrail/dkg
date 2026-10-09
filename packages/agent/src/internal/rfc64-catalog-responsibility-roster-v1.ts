// SPDX-License-Identifier: Apache-2.0

/**
 * The part of a catalog responsibility pass that depends on the member roster
 * of a private graph.
 *
 * The roster comes from a chain read. When that read gets no answer, the
 * membership check says "not verified", which says nothing about the graph:
 * the node's own RPC budget did not admit the read, or the endpoint did not
 * reply in time. The pass then leaves a responsibility this node holds as a
 * member alone and asks again, instead of withdrawing it until the next
 * lifecycle event.
 */

import { createOperationContext, type Logger } from '@origintrail-official/dkg-core';
import { UnansweredAuthorityObservation } from './context-graph-authority/unanswered-authority-read.js';
import {
  describeUnansweredAuthorityCheck,
  unansweredAuthorityRecheckFor,
} from './unanswered-authority-recheck.js';
import {
  resolveRfc64CatalogResponsibilityReasonV1,
  type ResolveRfc64CatalogResponsibilityReasonInputV1,
  type Rfc64CatalogResponsibilityReasonV1,
  type Rfc64CatalogResponsibilitySelectionV1,
} from '../rfc64/catalog-responsibility-registry-v1.js';

export interface Rfc64CatalogResponsibilityRosterInputV1
  extends Omit<ResolveRfc64CatalogResponsibilityReasonInputV1, 'privateMembershipVerified'> {
  readonly contextGraphId: string;
  /**
   * The graphs to ask again are kept per owner, for the lifecycle that
   * `lifecycleSignal` ends.
   */
  readonly owner: object;
  readonly lifecycleSignal: AbortSignal;
  readonly log: Pick<Logger, 'info' | 'debug'>;
  /** Holds the graph's current responsibility. */
  readonly registry: {
    read(contextGraphId: string): Rfc64CatalogResponsibilitySelectionV1;
  };
  /** Whether the pass still owns the graph's responsibility revision. */
  isCurrent(): boolean;
  /** Reconcile the graph's responsibility again. */
  askAgain(): void;
}

/** What the pass does next: it ends with `keep`, or it commits `reason`. */
export interface Rfc64CatalogResponsibilityRosterDecisionV1 {
  readonly keep?: Rfc64CatalogResponsibilitySelectionV1;
  readonly reason: Rfc64CatalogResponsibilityReasonV1 | null;
}

export class Rfc64CatalogResponsibilityRosterV1 {
  readonly #rosterRead: UnansweredAuthorityObservation;

  constructor(private readonly input: Rfc64CatalogResponsibilityRosterInputV1) {
    this.#rosterRead = new UnansweredAuthorityObservation(input.contextGraphId);
  }

  /**
   * Run the membership check so that a roster read without an answer is
   * noticed. Returns exactly what the check returns: awaiting it through here
   * takes no more turns than awaiting it directly.
   */
  read<T>(check: () => T): T {
    return this.#rosterRead.run(check);
  }

  /** Call when the membership check has ended, or was not needed. */
  decide(privateMembershipVerified: boolean): Rfc64CatalogResponsibilityRosterDecisionV1 {
    const { input } = this;
    const { contextGraphId } = input;
    const lifecycleFacts = {
      nodeRole: input.nodeRole,
      subscribed: input.subscribed,
      coreHosted: input.coreHosted,
      accessPolicy: input.accessPolicy,
    } as const;
    const reason = resolveRfc64CatalogResponsibilityReasonV1({
      ...lifecycleFacts,
      privateMembershipVerified,
    });
    if (!input.isCurrent()) return { keep: input.registry.read(contextGraphId), reason };
    const authorityRecheck = unansweredAuthorityRecheckFor(input.owner, input.lifecycleSignal);
    const memberReason = resolveRfc64CatalogResponsibilityReasonV1({
      ...lifecycleFacts,
      privateMembershipVerified: true,
    });
    const unansweredRosterRead = this.#rosterRead.unanswered;
    if (unansweredRosterRead === undefined || memberReason === reason) {
      authorityRecheck.settle(contextGraphId);
      return { reason };
    }
    // The roster read behind the membership check got no answer, which is
    // the node's RPC budget or its endpoint and not the graph. The answer
    // would decide this graph's responsibility, so it is asked again
    // without waiting for the next lifecycle event. Until then a
    // responsibility this node holds as a member stays: it is what a
    // "yes" would give, and no roster said otherwise.
    const held = input.registry.read(contextGraphId);
    const kept = held.responsibilityReason === memberReason;
    const unansweredChecks = authorityRecheck.defer(contextGraphId, () => input.askAgain());
    input.log[unansweredChecks <= 1 ? 'info' : 'debug'](
      createOperationContext('system'),
      describeUnansweredAuthorityCheck({
        subject: `RFC-64 catalog responsibility for "${contextGraphId}"`,
        waitingFor: 'the member roster',
        read: unansweredRosterRead,
        meanwhile: kept ? 'the responsibility is kept' : 'not responsible yet',
        unansweredChecks,
      }),
    );
    return kept ? { keep: held, reason } : { reason };
  }
}
