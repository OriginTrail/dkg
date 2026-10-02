import { DKGAgent as RealDKGAgent } from '../../src/index.js';
import {
  contextGraphDataUri,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';

export type PublishProtocolAgent = RealDKGAgent;

/** Shared agent constructor for protocol E2E suites that isolate pre-RFC-64 behavior. */
export function createPublishProtocolAgent(
  config: Parameters<typeof RealDKGAgent.create>[0],
): Promise<PublishProtocolAgent> {
  return RealDKGAgent.create({
    rfc64CatalogActivation: { enabled: false },
    ...config,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stageRootlessAssertion(
  node: PublishProtocolAgent,
  contextGraphId: string,
  name: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
): Promise<void> {
  await node.assertion.create(contextGraphId, name);
  await node.assertion.write(contextGraphId, name, quads);
  await node.assertion.promote(contextGraphId, name);
}

export async function bindAndSubscribePublicContextGraph(
  node: PublishProtocolAgent,
  contextGraphId: string,
  onChainId: string,
): Promise<void> {
  // Role-aware activation fails closed until the local label is bound to the
  // live public on-chain CG. Protocol tests bind deterministically instead of
  // racing background ontology discovery before subscribing replicas.
  await node.store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
    object: `"${onChainId}"`,
    graph: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  }]);
  node.subscribeToContextGraph(contextGraphId);
}

export async function pollUntil<T>(
  queryFn: () => Promise<{ bindings: T[] }>,
  predicate: (bindings: readonly T[]) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: T[] = [];
  while (Date.now() < deadline) {
    const result = await queryFn();
    lastResult = result.bindings;
    if (predicate(lastResult)) return lastResult;
    await sleep(intervalMs);
  }
  return lastResult;
}
