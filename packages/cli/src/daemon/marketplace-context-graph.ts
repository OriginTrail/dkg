// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's marketplace in the Marketplace Context Graph (OT-RFC-27).
 * Each seller's offers are Knowledge Assets in the graph's Verifiable Memory,
 * one per service, which the graph's catalog carries to every node it admits.
 * The seller and the buyer's gateway each subscribe to the graph once it
 * admits the node, as the subscribe route admits a caller.
 */
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { OfferAssets, OfferQuad } from '@origintrail-official/dkg-marketplace';
import { CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS } from './context-graph-readiness-repeat.js';
import { readLocalAgentSubscriptionAdmission } from './context-graph-subscription-admission.js';

/**
 * Stage `quads` as the asset `name` (created, written and shared, which seals
 * it). Writes add to a draft, so a sealed version is first reopened from the
 * layer it is in and its draft discarded, then the whole offer written anew.
 */
async function stageOfferAsset(agent: DKGAgent, contextGraphId: string, name: string, quads: OfferQuad[]): Promise<void> {
  const state = (await agent.assertion.history(contextGraphId, name))?.state;
  if (state === 'promoted' || state === 'published' || state === 'finalized') {
    await agent.assertion.pullFrom(contextGraphId, name, state === 'promoted' ? 'swm' : 'vm', { onConflict: 'replace' });
  }
  if (state !== undefined && state !== 'discarded') await agent.assertion.discard(contextGraphId, name);
  await agent.assertion.create(contextGraphId, name);
  await agent.assertion.write(contextGraphId, name, quads);
  await agent.assertion.promote(contextGraphId, name);
}

/**
 * Publish `quads` as the asset `name` in the graph's Verifiable Memory, as the
 * node's default agent: staged, then published in one transaction, the sync
 * publish; publishing it updates the same asset. A promote an earlier attempt
 * left unfinished keeps the draft from changing until it runs again
 * (`KA_PROMOTE_RECOVERY_REQUIRED`): it is run again first, finishing with the
 * content it has, and the offer is then staged anew. Only a confirmed publish
 * counts.
 */
export async function publishOfferAsset(agent: DKGAgent, contextGraphId: string, name: string, quads: OfferQuad[]): Promise<{ kaId: bigint }> {
  try {
    await stageOfferAsset(agent, contextGraphId, name, quads);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'KA_PROMOTE_RECOVERY_REQUIRED') throw err;
    await agent.assertion.promote(contextGraphId, name);
    await stageOfferAsset(agent, contextGraphId, name, quads);
  }
  const published = await agent.publishFromFinalizedAssertion(contextGraphId, name);
  if (published.status !== 'confirmed') throw new Error(`${name} was not confirmed on chain (${published.status})`);
  return { kaId: published.kaId };
}

/** Where a seller's offers go: the graph's Verifiable Memory, once `admitted()` says the graph admits the node. */
export function offerAssetsIn(agent: DKGAgent, contextGraphId: string, admitted: () => boolean): OfferAssets {
  return {
    contextGraphId,
    publish: async (name, quads) => {
      if (!admitted()) throw Object.assign(new Error(`"${contextGraphId}" has not admitted this node yet`), { code: 'MARKETPLACE_NOT_ADMITTED' });
      return publishOfferAsset(agent, contextGraphId, name, quads);
    },
    recover: (evidence) => agent.recoverRfc64ConfirmedCatalogObligationV1(evidence),
  };
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
