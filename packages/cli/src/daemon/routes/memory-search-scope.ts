// SPDX-License-Identifier: Apache-2.0

import { canonicalKnowledgeAssetAgentAddress } from '@origintrail-official/dkg-core';
import type { VectorWorkingMemoryScope } from '../../vector-store.js';
import type { RequestActor } from './context.js';

type MemoryLayer = 'wm' | 'swm' | 'vm';

export function memorySearchPlans(
  memoryLayers: readonly MemoryLayer[], actor: RequestActor,
  listLocalAgents: () => ReadonlyArray<{ agentAddress: string }>,
) {
  const callerAgentAddress = actor.authenticatedAgentAddress;
  const isNodeAdmin = actor.authentication.principal.kind === 'nodeOperator';
  // Working memory is per-agent, so the `wm` view needs an address:
  //   - an agent-scoped caller reads its OWN working memory, and
  //     `DKGAgent.query`'s A-1 check rejects anything else;
  //   - a node operator spans every agent registered on this node;
  //   - an anonymous / auth-disabled caller supplies no address, so the
  //     engine falls back to the node's default agent — the same contract
  //     `/api/query` applies.
  // `swm` and `vm` are context-graph-wide by design and take no address.
  //
  // IMPORTANT — what the node-operator exemption does NOT buy. Skipping the
  // route's own gate above only skips THIS route's 403. Every `agent.query`
  // below still runs `DKGAgent.query`'s own `canReadContextGraph`
  // (`dkg-agent-query.ts`), and a node token resolves `callerAgentAddress`
  // to `undefined`, so that check falls back to NODE-LOCAL authority —
  // whether any agent registered here is in the CG's roster. There is no
  // admin bypass inside the engine.
  //
  // So for a context graph this node HOLDS but none of its agents are
  // rostered for, the route admits the request and the engine returns an
  // empty result. A node operator therefore gets a cross-AGENT view within
  // the context graphs this node may read — not an unconditional cross-CG
  // one. An earlier revision of this comment claimed the latter; it was
  // wrong, and the tests could not catch it because the fake `agent.query`
  // has no authority check of its own.
  const workingMemoryAddresses: Array<string | undefined> = callerAgentAddress
    ? [callerAgentAddress]
    : isNodeAdmin
      ? (listLocalAgents().map((a) => a.agentAddress) as string[])
      : [undefined];
  const searchPlans: Array<{ view: 'working-memory' | 'shared-working-memory' | 'verifiable-memory'; agentAddress?: string }> = [];
  for (const layer of memoryLayers) {
    if (layer === 'wm') {
      // A node operator with no registered agents still gets the engine
      // default rather than silently skipping the whole layer.
      const addresses = workingMemoryAddresses.length > 0 ? workingMemoryAddresses : [undefined];
      for (const agentAddress of addresses) {
        searchPlans.push({ view: 'working-memory', agentAddress });
      }
      continue;
    }
    searchPlans.push({
      view: layer === 'swm' ? 'shared-working-memory' : 'verifiable-memory',
    });
  }

  return searchPlans;
}

/** Match the default agent's EVM/legacy-peer aliases without granting them to co-tenants. */
export function memorySearchVectorScope(
  agent: { readonly peerId: string; getDefaultAgentAddress(): string | undefined },
  actor: RequestActor,
): VectorWorkingMemoryScope {
  if (actor.authentication.principal.kind === 'nodeOperator') return { kind: 'nodeOperator' };
  const defaultAddress = agent.getDefaultAgentAddress() ?? agent.peerId;
  const caller = canonicalKnowledgeAssetAgentAddress(actor.effectiveAgentAddress);
  const addresses = caller === canonicalKnowledgeAssetAgentAddress(defaultAddress)
    ? [caller, agent.peerId] : [caller];
  return { kind: 'agents', agentAddresses: addresses };
}
