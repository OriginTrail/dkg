// SPDX-License-Identifier: Apache-2.0
import { validateContextGraphId } from '@origintrail-official/dkg-core';
import { holdsContextGraphGraphs } from './context-graph-held-graphs.js';
import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type { DKGAgent } from './dkg-agent.js';

/** How a caller wants a refusal: the answer for no data, or an access error. */
export interface UnheldContextGraphReadOptions {
  accessDenied?: 'empty' | 'error';
  signal?: AbortSignal;
}

/**
 * The read authority to act on for a context graph this node may hold nothing
 * of: no subscription, local create, declaration or graph. Such an id is
 * refused as a caller who may not read it is refused, whatever the request.
 *
 * - The legacy fallback reads a context graph without a local policy as
 *   public. It is refused only when the store also holds neither the id's root
 *   graph nor a graph in its reserved partitions, so an undeclared id with data
 *   stays readable. A child context graph's graphs do not count.
 * - A name the chain proves unregistered, with no policy accepted for it.
 * - An authority read the chain cannot answer now, unless the caller asks for
 *   access errors: that caller keeps the retryable answer every other context
 *   graph gets meanwhile.
 *
 * Any other decision is returned as it is. A malformed id is never refused
 * here, so its answer cannot depend on the reads made for it.
 */
export async function denyUnheldContextGraphRead(
  agent: DKGAgent,
  contextGraphId: string,
  decision: ContextGraphReadAuthorityDecision,
  options: UnheldContextGraphReadOptions = {},
): Promise<ContextGraphReadAuthorityDecision> {
  const fallback = decision.outcome === 'allowed'
    && decision.source === 'legacy-local' && decision.reason === 'local-public';
  const unanswered = decision.outcome === 'unavailable' && (
    decision.reason === 'finalized-name-absence-unaccepted'
    || (decision.reason === 'authority-circuit-open' && options.accessDenied !== 'error'));
  if (
    (!fallback && !unanswered)
    || !validateContextGraphId(contextGraphId).valid
    || agent.keepsContextGraphLocally(contextGraphId)
    || await agent.contextGraphExists(contextGraphId, { signal: options.signal })
    || (fallback && await holdsContextGraphGraphs(agent.store, contextGraphId, options.signal))
  ) return decision;
  return { outcome: 'denied', grantScope: 'none', source: decision.source, reason: 'context-graph-not-held', metadataBootstrap: 'forbidden' };
}
