// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's marketplace in the Marketplace Context Graph (OT-RFC-27).
 * Under the RFC-64 catalog, which carries a graph's shared memory between
 * nodes, only Knowledge Assets in the graph's root scope travel, and only on
 * a node that has accepted the graph's policy. So the seller writes each copy
 * of an offer as its own asset, and the seller and the buyer's gateway each
 * subscribe to the graph once it admits the node, as the subscribe route
 * admits a caller.
 */
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { OfferQuad } from '@origintrail-official/dkg-marketplace';
import { CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS } from './context-graph-readiness-repeat.js';
import { readLocalAgentSubscriptionAdmission } from './context-graph-subscription-admission.js';

/**
 * One offer, the quads of one subject, as its own Knowledge Asset in the
 * graph's shared memory, named after that subject: created, written and
 * shared, which seals it as the node's own, with no transaction. An asset
 * shared once is not written again, so every copy is a new one.
 */
export async function shareOfferAsset(agent: DKGAgent, contextGraphId: string, quads: OfferQuad[]): Promise<void> {
  const name = `offer-${quads[0]!.subject.split(':').pop()}`;
  await agent.assertion.create(contextGraphId, name);
  await agent.assertion.write(contextGraphId, name, quads);
  if (!(await agent.assertion.promote(contextGraphId, name)).shareOperationId) throw new Error(`${name} was not shared`);
}

/**
 * Subscribe to a graph once it admits the node, read as the daemon reads work
 * the node starts itself, with the subscribe route's admission: always on,
 * under the on-chain id the admission read, then its catalog responsibility
 * refreshed, as a catch-up refreshes it, so the node shares into it at once.
 * A graph that is not registered on chain is admitted on its owner's signed
 * policy, from a connected peer. An admission that cannot be read yet, as at
 * boot before a peer connects, is asked again after the readiness repeat's
 * delays, the last one over and over; a refusal is final. Returns a function
 * that stops asking.
 */
export function subscribeWhenAdmitted(
  agent: DKGAgent,
  contextGraphId: string,
  options: { log?: (message: string) => void; onAdmitted?: () => void } = {},
): () => void {
  const delays = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (asked: number): Promise<void> => {
    try {
      const admission = await readLocalAgentSubscriptionAdmission(agent, contextGraphId);
      if (stopped) return;
      if (admission === 'denied') {
        options.log?.(`[marketplace] "${contextGraphId}" does not admit this node: not subscribed`);
        return;
      }
      if (admission !== 'unavailable') {
        const onChainId = admission.authority.onChainId?.toString(10);
        agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', ...(onChainId === undefined ? {} : { onChainId }) });
        await agent.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
        if (stopped) return;
        options.log?.(`[marketplace] "${contextGraphId}" admits this node: subscribed`);
        options.onAdmitted?.();
        return;
      }
    } catch {
      // Asked again, as an admission that could not be read.
    }
    if (stopped) return;
    if (asked === 0) options.log?.(`[marketplace] "${contextGraphId}" cannot admit this node yet: asked again later`);
    timer = setTimeout(() => void attempt(asked + 1), delays[Math.min(asked, delays.length - 1)]);
    timer.unref?.();
  };
  void attempt(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
