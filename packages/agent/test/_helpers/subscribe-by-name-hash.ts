/**
 * The agent-level calls `POST /api/context-graph/subscribe` makes for a name
 * hash, in the route's order (packages/cli/src/daemon/routes/context-graph.ts):
 * alias lookup, subscribe-path read authority, a bounded pre-resolution of the
 * hash, then `subscribeToContextGraph` under the id that resolved.
 *
 * This is NOT the route. It exists so agent-package suites can put a node into
 * the state `dkg subscribe <hash>` leaves it in, in one place instead of one
 * copy per suite. Where the route's own ordering matters, it is pinned by
 * packages/cli/test/context-graph-name-hash-subscribe-route.test.ts and driven
 * for real, over HTTP against real daemons, by devnet/public-cg-hash-subscription.
 * If the route's sequence changes, change it here too.
 */
import { expect } from 'vitest';
import type { DKGAgent } from '../../src/index.js';

export async function subscribeByNameHash(agent: DKGAgent, requested: string) {
  let contextGraphId = agent.resolveContextGraphIdAlias(requested) ?? requested;
  const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
    callerAgentAddress: agent.getDefaultAgentAddress(),
    allowSubscriptionFallback: false,
  });
  expect(
    authority.outcome,
    JSON.stringify(authority, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  ).toBe('allowed');
  if (agent.contextGraphNameTargetFor(contextGraphId)) {
    const resolved = await agent.resolveContextGraphNameHashNow(contextGraphId, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (resolved) contextGraphId = resolved;
  }
  // What `dkg subscribe` prints as its note, read before the subscribe mutates the row.
  const identity = agent.describeContextGraphIdentity(requested);
  agent.subscribeToContextGraph(contextGraphId, {
    syncMode: 'always-on',
    ...(authority.onChainId === undefined ? {} : { onChainId: authority.onChainId.toString(10) }),
  });
  return { contextGraphId, authority, identity };
}
