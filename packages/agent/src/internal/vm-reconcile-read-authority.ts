// SPDX-License-Identifier: Apache-2.0

/**
 * What a VM reconcile pass makes of a read-authority check that was not
 * allowed.
 *
 * A denial closes the pass, and so does an authority source that answered
 * "unknown". A chain read that was never answered is different: the node's own
 * RPC budget did not admit it, or the endpoint did not reply in time. That
 * says nothing about the graph, and the same question may be answered a
 * moment later, so the pass is told apart and its graph can be asked again
 * without waiting for the periodic sweep.
 */

import type {
  ContextGraphReadAuthorityDecision,
  UnavailableContextGraphReadAuthorityDecision,
} from '../context-graph-read-authority.js';
import { ContextGraphNotFoundError } from '../dkg-agent-types.js';
import { isUnansweredChainReadAuthorityDecision } from './context-graph-authority/unanswered-authority-read.js';

/** Whether the decision is "no answer from the chain" rather than a refusal. */
export function isUnansweredVmReconcileReadAuthority(
  decision: ContextGraphReadAuthorityDecision | undefined,
): decision is UnavailableContextGraphReadAuthorityDecision {
  return isUnansweredChainReadAuthorityDecision(decision);
}

/**
 * The pass could not confirm read authority because the chain read behind the
 * check got no answer. To a caller it is the refusal it always was, a
 * {@link ContextGraphNotFoundError} with the same message; reconcile
 * scheduling tells it apart by class.
 */
export class VmReconcileReadAuthorityUnansweredError extends ContextGraphNotFoundError {
  /** `source/reason/dependency` of the unanswered decision, for the node's log. */
  readonly readAuthority: string;

  constructor(
    contextGraphId: string,
    decision: Pick<UnavailableContextGraphReadAuthorityDecision, 'source' | 'reason' | 'dependency'>,
  ) {
    super(contextGraphId);
    this.readAuthority = `${decision.source}/${decision.reason}/${decision.dependency}`;
  }
}
