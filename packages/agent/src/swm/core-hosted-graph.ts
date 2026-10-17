// SPDX-License-Identifier: Apache-2.0

/**
 * A Core that hosts a public context graph carries its members' shares into
 * named sub-graphs, as a subscriber does.
 *
 * The catalog owns the root scope of a catalog-mode graph; its named
 * sub-graphs stay on the member lane, which a node used to join only by
 * subscribing. An Edge that reaches the graph only through Cores (a relay-only
 * Edge) sends its shares to the graph's topic subscribers, which are those
 * Cores. A Core that hosts the graph without subscribing to it declined every
 * one of them, so a member's share reached nobody it was not connected to
 * directly, the graph's owner included.
 *
 * Such a Core now applies them, through every check of the share handler, and
 * serves them to pulls like any member. It also tells the graph's owner of
 * each one when the owner is connected to it (the change notice,
 * `swm/shared-memory-change-notice.ts`), so that the owner pulls the share
 * from it at once. The root scope stays with the catalog.
 */

import type { ContextGraphSub } from '../dkg-agent-types.js';
import type { DKGAgent } from '../dkg-agent.js';

/** What the hosting check reads of a node (the agent keeps these protected). */
interface CoreHostedGraphNode {
  readonly config: { readonly nodeRole?: string };
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  rfc64AuthorityContextGraphIdV1(contextGraphId: string): string;
}

/**
 * True on a Core that hosts the public graph, whether or not it subscribes to
 * it. A Core records a graph as hosted (`coreHosted`) only for a public graph,
 * when it signs a StorageACK for it; a wire id is read as its graph.
 */
export function hostsPublicGraphAsCore(agentObject: DKGAgent | object, contextGraphId: string): boolean {
  const node = agentObject as CoreHostedGraphNode;
  return (node.config.nodeRole ?? 'edge') === 'core'
    && node.subscribedContextGraphs.get(node.rfc64AuthorityContextGraphIdV1(contextGraphId))?.coreHosted === true;
}
