// SPDX-License-Identifier: Apache-2.0

/**
 * The named sub-graphs a shared-memory pull admits (#3301).
 *
 * A responder serves the sub-graphs registered on it. A node that follows a
 * graph learns the graph's sub-graphs from what it is served (nothing
 * replicates their registrations for a graph whose root is catalog-owned), so
 * a pull admits a served sub-graph whether or not the node created it. A
 * served name that is a context graph of the node's own at `<graph>/<name>`
 * names that graph's shared memory, not a sub-graph's, and is never admitted.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import { discoverSwmRecoverySubGraphNames } from '../graph-scoped-swm-recovery.js';

export async function admitServedSubGraphNames(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly registeredSubGraphNames: readonly string[] | undefined;
  readonly excludedSubGraphNames: readonly string[] | undefined;
  /** True when `<graph>/<name>` is a context graph of this node's own. */
  readonly isOwnContextGraph?: (contextGraphId: string, name: string) => Promise<boolean>;
}): Promise<string[]> {
  const admitted = new Set(params.registeredSubGraphNames ?? []);
  const served = discoverSwmRecoverySubGraphNames({
    contextGraphId: params.contextGraphId,
    metaQuads: params.metaQuads,
    excludedSubGraphNames: params.excludedSubGraphNames,
  });
  for (const name of served) {
    if (admitted.has(name)) continue;
    if (await params.isOwnContextGraph?.(params.contextGraphId, name)) continue;
    admitted.add(name);
  }
  return [...admitted];
}
