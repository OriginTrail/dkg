// daemon/context-graph-subscription-admission.ts
//
// Who is admitted to a Context Graph's subscription, and who may follow a
// public reference to a graph (its on-chain name hash) to the cleartext id
// this node resolved it to.
//
// The name hash is public on chain. The cleartext id names the graph, so a
// route that accepts the hash follows it to that id only for a caller who
// could already read the graph: the node operator, or an agent the subscribe
// route would admit to the cleartext id. Unsubscribe and catch-up status
// apply this rule, and answer a refused caller as they answer an id they
// hold nothing for.

import type { DKGAgent } from '@origintrail-official/dkg-agent';

/**
 * The read-authority decision that admits a caller to a Context Graph's
 * subscription. It is the single admission boundary for subscribe, and for
 * every route that follows a name hash to the cleartext id it resolves to,
 * so those routes cannot drift apart. The caller is the request's agent, or
 * the node's default agent for a node-level token. The legacy subscription
 * fallback stays off: a subscription cannot be its own authorization proof.
 * Each route maps the decision itself; a throw is the route's to handle.
 */
export async function readContextGraphSubscriptionAdmission(
  agent: DKGAgent,
  contextGraphId: string,
  requestAgentAddress: string | undefined,
): Promise<{
  callerAgentAddress: string | undefined;
  authority: Awaited<ReturnType<DKGAgent['resolveContextGraphSubscriptionBootstrapAuthority']>>;
}> {
  const callerAgentAddress = requestAgentAddress ?? agent.getDefaultAgentAddress();
  const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
    callerAgentAddress,
    allowSubscriptionFallback: false,
    // This explicit admission boundary may spend a bounded cold lookup to
    // populate the chain adapter's reverse name-hash index. Ordinary
    // queries and restart rehydration retain the short fail-closed timeout.
  });
  return { callerAgentAddress, authority };
}

/** An admission read: the caller it was read for, and the decision. */
export type ContextGraphSubscriptionAdmission = Awaited<ReturnType<typeof readContextGraphSubscriptionAdmission>>;

/**
 * The admission of work this node starts on its own for a subscription, such
 * as catching up one it restored. No request names an agent, and the node's
 * default agent is only one of its local agents, so the graph is read as its
 * own local agent: the one the graph names (its allowlist, or this node's join
 * of it), then each other local agent; the first admitted is the caller.
 * `'unavailable'` when a read could not be answered before one was admitted,
 * so asking again later may admit one; `'denied'` when every one was refused.
 */
export async function readLocalAgentSubscriptionAdmission(
  agent: DKGAgent,
  contextGraphId: string,
): Promise<ContextGraphSubscriptionAdmission | 'unavailable' | 'denied'> {
  const named = await agent.findLocalAgentForContextGraph(contextGraphId).catch(() => undefined);
  const localAgents = new Map<string, string>();
  for (const address of [named, ...agent.listLocalAgents().map((local) => local.agentAddress)]) {
    if (address !== undefined && !localAgents.has(address.toLowerCase())) {
      localAgents.set(address.toLowerCase(), address);
    }
  }
  // A node without local agents reads as its default agent.
  const callers = localAgents.size > 0 ? [...localAgents.values()] : [undefined];
  for (const caller of callers) {
    const admission = await readContextGraphSubscriptionAdmission(agent, contextGraphId, caller)
      .catch(() => undefined);
    if (admission === undefined || admission.authority.outcome === 'unavailable') return 'unavailable';
    if (admission.authority.outcome === 'allowed') return admission;
  }
  return 'denied';
}

/** The caller of a route that follows a public reference to a Context Graph row. */
export interface ContextGraphFollowCaller {
  /** The request carries node-operator authority. */
  readonly isNodeAdmin: boolean;
  /** The request's agent, if any; the node's default agent stands in otherwise. */
  readonly agentAddress: string | undefined;
}

/**
 * Whether `caller` may follow a public reference to `contextGraphId`, the
 * cleartext id this node resolved it to. The node operator can already list
 * every subscription, so it follows without a read. Any other caller follows
 * only when the subscribe route would admit it to that id. An admission read
 * that throws is `unavailable`; each route decides how it answers a refusal
 * and an outage.
 */
export async function admitContextGraphFollow(
  agent: DKGAgent,
  contextGraphId: string,
  caller: ContextGraphFollowCaller,
): Promise<'allowed' | 'denied' | 'unavailable'> {
  if (caller.isNodeAdmin) return 'allowed';
  try {
    const { authority } = await readContextGraphSubscriptionAdmission(agent, contextGraphId, caller.agentAddress);
    return authority.outcome;
  } catch {
    return 'unavailable';
  }
}
