// SPDX-License-Identifier: Apache-2.0
import type { ViewReadGraphs } from '@origintrail-official/dkg-query';
import {
  readGraphLayerOf, readGraphModeOf, viewSemanticsOf, workingMemoryIdentityRule, type WorkingMemoryIdentityRule,
} from '@origintrail-official/dkg-storage';

/**
 * The read graphs that merged view queries may read on this node, taken from
 * its store's read-graph layer:
 * - a read graph is kept for merged queries only where the node serves it:
 *   `query.readGraphs` is `serve` for its context graph and layer;
 * - its state is the row in the backend's process-wide mirror;
 * - the working-memory identity rule and the default semantics
 *   (`query.viewSemantics`) are the runtime's.
 *
 * Every field reads the runtime when it is called, so a setting, a rule or a
 * row that changes later is seen. A store without a read-graph layer has no
 * source, and every view query on it is per asset.
 */
export function viewReadGraphsOf(store: unknown): ViewReadGraphs | undefined {
  const runtime = readGraphLayerOf(store)?.runtime;
  if (runtime === undefined) return undefined;
  return {
    keeps: (key) => readGraphModeOf(runtime.modes, key) === 'serve',
    state: (readGraph) => runtime.mirror.get(readGraph),
    get identity() {
      return runtime.workingMemoryIdentity;
    },
    defaultSemantics: (contextGraphId) => viewSemanticsOf(runtime.viewSemantics, contextGraphId),
  };
}

/** The node as its working-memory identity rule sees it. Either value may be absent. */
export interface ReadGraphNodeIdentity {
  readonly defaultAgentAddress?: string;
  readonly peerId?: string;
}

/**
 * Give the backend's read-graph runtime the node's working-memory identity
 * rule: every agent owns the drafts written under its own address, and the
 * default agent also those written under the node's peer ID. Merged view
 * queries and the layer's maintenance both map drafts to agents with it.
 *
 * `node` is read at each use, so a later change of the default agent applies
 * at once; when it cannot be read (a node that has stopped), the rule knows
 * neither. A store without a read-graph layer is left as it is.
 */
export function installReadGraphWorkingMemoryIdentity(store: unknown, node: () => ReadGraphNodeIdentity): void {
  const runtime = readGraphLayerOf(store)?.runtime;
  if (runtime === undefined) return;
  let last: { readonly defaultAgentAddress?: string; readonly peerId?: string; readonly rule: WorkingMemoryIdentityRule } | undefined;
  const current = (): WorkingMemoryIdentityRule => {
    let identity: ReadGraphNodeIdentity;
    try {
      identity = node();
    } catch {
      identity = {};
    }
    const { defaultAgentAddress, peerId } = identity;
    let entry = last;
    if (entry === undefined || entry.defaultAgentAddress !== defaultAgentAddress || entry.peerId !== peerId) {
      entry = { defaultAgentAddress, peerId, rule: workingMemoryIdentityRule({ defaultAgentAddress, peerId }) };
      last = entry;
    }
    return entry.rule;
  };
  runtime.workingMemoryIdentity = {
    ownerOf: (address) => current().ownerOf(address),
    addressesOf: (agentAddress) => current().addressesOf(agentAddress),
  };
}
