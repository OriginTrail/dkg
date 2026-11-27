// SPDX-License-Identifier: Apache-2.0

/**
 * Which peer-to-agent binding a node's catalog uses for one context graph.
 *
 * `rfc64Catalog.accessPolicyAuthority` is a manual peer table for the
 * selected private graphs of the activation config: its validator checks it
 * against their rosters and nothing else. Applied to every graph, it left a
 * member of any other private graph (one joined at runtime, say) without an
 * identity on the node, so the node denied every catalog operation with that
 * member, and with them the member's writes into the graph's root.
 *
 * The table now answers for the graphs it was configured for. Every other
 * graph's peers are resolved from that graph's own authenticated state, as on
 * a node without the table. A function authority supplied in code keeps
 * answering for every graph: it is given the graph and decides itself.
 */

import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { Rfc64CatalogAccessPolicyAuthorityConfigV1 } from '../dkg-agent-types.js';
import type {
  Rfc64CatalogAccessPolicyRegistryOptionsV1,
  Rfc64CatalogLocalAuthorizationScopeV1,
} from './catalog-access-policy-v1.js';

export interface Rfc64CatalogAccessAuthorityScopeInputV1 {
  /** The node's configured authority: a manual peer table or a function supplied in code. */
  readonly manual: Readonly<Rfc64CatalogAccessPolicyAuthorityConfigV1> | undefined;
  /** The graphs a manual peer table covers; undefined for a function authority. */
  readonly manualContextGraphs: readonly string[] | undefined;
  /** The graph-scoped resolvers a node without a configured authority uses. */
  readonly resolveLocalAgentAddress: (
    contextGraphId: ContextGraphIdV1,
    scope?: Readonly<Rfc64CatalogLocalAuthorizationScopeV1>,
  ) => Promise<EvmAddressV1 | null>;
  readonly resolveRemoteAgentAddress: (
    remotePeerId: string,
    contextGraphId: ContextGraphIdV1,
  ) => Promise<EvmAddressV1 | null>;
}

export function scopeRfc64CatalogAccessAuthorityV1(
  input: Rfc64CatalogAccessAuthorityScopeInputV1,
): Rfc64CatalogAccessPolicyRegistryOptionsV1 {
  const { manual, manualContextGraphs } = input;
  if (manual === undefined) {
    return {
      resolveLocalAgentAddress: input.resolveLocalAgentAddress,
      resolveRemoteAgentAddress: input.resolveRemoteAgentAddress,
    };
  }
  if (manualContextGraphs === undefined) return manual;
  const covered = new Set<string>(manualContextGraphs);
  return {
    resolveLocalAgentAddress: async (contextGraphId, scope) => (
      covered.has(contextGraphId)
        ? manual.localAgentAddress
        : input.resolveLocalAgentAddress(contextGraphId, scope)
    ),
    resolveRemoteAgentAddress: async (remotePeerId, contextGraphId) => (
      covered.has(contextGraphId)
        ? manual.resolveRemoteAgentAddress(remotePeerId, contextGraphId)
        : input.resolveRemoteAgentAddress(remotePeerId, contextGraphId)
    ),
  };
}
