/**
 * OT-RFC-27 marketplace — the agent side of offer publication: the ONE
 * on-chain anchor of the shared `marketplace` Context Graph, and the named
 * Knowledge Asset lifecycle that publishes and updates each offer KA.
 *
 * Anchor. ContextGraphStorage does not enforce name-hash uniqueness, so two
 * sellers that each register "marketplace" split the network: every node
 * binds whichever slot it saw first, the slots carry different RFC-64 policy
 * digests (catalog transfer between the halves is denied), and the name's
 * reverse resolution turns ambiguous and fails closed. A seller therefore
 * asks the chain itself — an uncached, current-state reverse lookup of the
 * name commitment — before anything else: an existing anchor is adopted
 * (this node binds that slot and never creates or registers its own graph);
 * only when the chain proves there is none does the seller create and
 * register the graph. A local "not registered yet" or a finalized-state
 * authority read cannot answer this: both lag a registration that is seconds
 * old, which is exactly how the second seller used to mint a duplicate.
 *
 * Lifecycle. An offer KA's update must be numbered confirmed version + 1, so
 * every version is published to Verifiable Memory: create → write → share
 * (seals and shares the draft) → publish (mint, then on-chain update of the
 * same KA). A republish first reopens the asset through the sanctioned
 * pull-from path and discards that seeded draft, so the new version carries
 * exactly the new offer and keeps the KA's identity.
 */
import {
  MARKETPLACE_CONTEXT_GRAPH,
  MemoryLayer,
  contextGraphLayerPrefixCandidates,
  contextGraphLayerUri,
  isSafeIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../dkg-agent.js';
import { publishedOfferRevision, type MarketplaceOfferAssetPort } from './offer-publisher.js';
import type { MarketplaceLogger } from './seller-service.js';

/** How long a seller waits for its node to bind an existing anchor. */
const ANCHOR_ADOPTION_TIMEOUT_MS = 30_000;
const ANCHOR_ADOPTION_POLL_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Current on-chain slot committed to the marketplace name: a slot id, null
 * when the chain proves there is none, or undefined when this adapter cannot
 * answer. Throws when the name commits to several slots (a split network the
 * operator must resolve). The bulk lookup never reuses a cached miss.
 */
export async function resolveMarketplaceAnchorOnChain(
  agent: DKGAgent,
  chain: ChainAdapter,
): Promise<bigint | null | undefined> {
  const nameHash = agent.contextGraphNameCommitment(MARKETPLACE_CONTEXT_GRAPH);
  if (typeof chain.resolveContextGraphIdsByNameHashes === 'function') {
    const bindings = await chain.resolveContextGraphIdsByNameHashes([nameHash]);
    return bindings.get(nameHash) ?? null;
  }
  if (typeof chain.resolveContextGraphIdByNameHash === 'function') {
    return chain.resolveContextGraphIdByNameHash(nameHash);
  }
  return undefined;
}

async function adoptMarketplaceAnchor(agent: DKGAgent, anchored: bigint, log: MarketplaceLogger): Promise<void> {
  const cg = MARKETPLACE_CONTEXT_GRAPH;
  const expected = anchored.toString();
  agent.subscribeToContextGraph(cg, { syncMode: 'always-on' });
  const deadline = Date.now() + ANCHOR_ADOPTION_TIMEOUT_MS;
  let primed = false;
  for (;;) {
    const bound = await agent.getContextGraphOnChainId(cg).catch(() => null);
    if (bound === expected) {
      if (primed) {
        log.info(`[marketplace] adopted the "${cg}" context graph anchored on-chain by another seller (onChainId=${expected})`);
      }
      return;
    }
    if (bound !== null) {
      throw new Error(
        `marketplace: this node is bound to on-chain slot ${bound} for "${cg}", but the chain anchors the name at `
        + `${expected} — refusing to publish offers into a split marketplace`,
      );
    }
    const subscription = agent.getSubscribedContextGraphs().get(cg);
    if (subscription) {
      primed = true;
      await agent.selfPrimeSubscriptionOnChainId(cg, subscription, anchored).catch(() => null);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `marketplace: the "${cg}" context graph is anchored on-chain (onChainId=${expected}) but this node has not `
        + 'bound it yet — retry the publish shortly (it never registers a second anchor)',
      );
    }
    await sleep(ANCHOR_ADOPTION_POLL_MS);
  }
}

/**
 * Leave this node bound to the single on-chain registration of the
 * marketplace CG: adopt an existing anchor, or create and register the graph
 * when the chain proves there is none. Failures propagate — without the
 * anchor no offer can be published to Verifiable Memory.
 */
export async function ensureMarketplaceContextGraphAnchor(
  agent: DKGAgent,
  chain: ChainAdapter,
  log: MarketplaceLogger,
): Promise<void> {
  const cg = MARKETPLACE_CONTEXT_GRAPH;
  const anchored = await resolveMarketplaceAnchorOnChain(agent, chain);
  if (anchored !== undefined && anchored !== null) {
    await adoptMarketplaceAnchor(agent, anchored, log);
    return;
  }
  if (anchored === undefined && await agent.isContextGraphRegistered(cg)) return;
  if (!(await agent.contextGraphExists(cg))) {
    await agent.createContextGraph({
      id: cg,
      name: 'Marketplace',
      description: 'OT-RFC-27 NeuroSymbolic Marketplace offers',
    });
  }
  const { onChainId, txHash } = await agent.registerContextGraph(cg);
  log.info(
    `[marketplace] anchored the "${cg}" context graph on-chain (onChainId=${onChainId}${txHash ? `, tx=${txHash}` : ''}); `
    + 'other sellers adopt this anchor and buyers verify its authority',
  );
  // A seller that registered in the same block window cannot be prevented
  // here (the chain does not enforce name uniqueness); make it loud.
  await resolveMarketplaceAnchorOnChain(agent, chain).catch((error: unknown) => {
    log.warn(
      `[marketplace] the "${cg}" name now resolves to more than one on-chain anchor — offers will not converge `
      + `until the duplicate is retired: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * The offer-KA publish port over the agent's named KA lifecycle, authored by
 * `authorAddress` (the seller's receipt-signing agent).
 */
export function createMarketplaceOfferAssetPort(agent: DKGAgent, authorAddress: string): MarketplaceOfferAssetPort {
  const cg = MARKETPLACE_CONTEXT_GRAPH;
  const lane = { agentAddress: authorAddress };

  /** Reopen an existing asset so its next version replaces, not extends, its content. */
  const reopen = async (assetName: string): Promise<void> => {
    const history = await agent.assertion.history(cg, assetName, lane);
    if (!history || history.state === 'discarded') return;
    let source: 'vm' | 'swm' | undefined = history.vmCurrentAssertion
      ? 'vm'
      : history.swmCurrentAssertion ? 'swm' : undefined;
    if (source === undefined && history.status === 'wm-sealed') {
      // An earlier publish sealed this draft and stopped before sharing it:
      // finish that share so the sanctioned pull-from path can reopen it.
      await agent.assertion.promote(cg, assetName, lane);
      source = 'swm';
    }
    if (source !== undefined) {
      await agent.assertion.pullFrom(cg, assetName, source, { ...lane, onConflict: 'replace' });
    }
    await agent.assertion.discard(cg, assetName, lane);
  };

  const toQuads = (rows: ReadonlyArray<Record<string, string>>): Quad[] => rows.map((row): Quad => ({
    subject: row['s'] ?? '',
    predicate: row['p'] ?? '',
    object: row['o'] ?? '',
    graph: '',
  }));

  /**
   * The newest version of `subject` in this node's Verifiable Memory under
   * this author's own KA graphs — the confirmed offer when the local
   * lifecycle record is gone (a store that did not survive a restart).
   */
  const newestAuthoredOffer = async (subject: string): Promise<Quad[] | null> => {
    if (!isSafeIri(subject)) return null;
    const [prefix] = contextGraphLayerPrefixCandidates(cg, MemoryLayer.VerifiableMemory, authorAddress);
    const result = await agent.store.query(
      `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${subject}> ?p ?o } FILTER(STRSTARTS(STR(?g), ${sparqlString(prefix)})) }`,
      { source: 'agent.marketplace.readAuthoredOffer' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const byGraph = new Map<string, Quad[]>();
    for (const row of result.bindings) {
      const graph = row['g'] ?? '';
      const quads = byGraph.get(graph) ?? [];
      quads.push({ subject, predicate: row['p'] ?? '', object: row['o'] ?? '', graph: '' });
      byGraph.set(graph, quads);
    }
    let newest: Quad[] | null = null;
    for (const quads of byGraph.values()) {
      if (newest === null || publishedOfferRevision(quads, subject) > publishedOfferRevision(newest, subject)) {
        newest = quads;
      }
    }
    return newest;
  };

  return {
    async readPublishedOffer(assetName, subject) {
      const history = await agent.assertion.history(cg, assetName, lane);
      if (!history) return newestAuthoredOffer(subject);
      if (!history.vmCurrentAssertion || history.kaNumber === undefined) return null;
      const graph = contextGraphLayerUri(cg, MemoryLayer.VerifiableMemory, history.agentAddress, history.kaNumber);
      const result = await agent.store.query(
        `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
        { source: 'agent.marketplace.readPublishedOffer' },
      );
      return result.type === 'bindings' ? toQuads(result.bindings) : null;
    },

    async publishOfferAsset(assetName, quads) {
      await reopen(assetName);
      await agent.assertion.create(cg, assetName, lane);
      await agent.assertion.write(cg, assetName, quads, lane);
      await agent.assertion.promote(cg, assetName, lane);
      const result = await agent.publishFromFinalizedAssertion(cg, assetName, lane);
      if (result.status === 'failed') {
        throw new Error(`marketplace: publishing offer asset "${assetName}" to Verifiable Memory failed`);
      }
      return result.ual !== undefined ? { ual: result.ual } : {};
    },
  };
}
