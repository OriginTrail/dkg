// SPDX-License-Identifier: Apache-2.0

/**
 * The network's Marketplace Context Graph (OT-RFC-27). A network config
 * (`network/<name>.json`) may name the graph that its nodes' marketplace uses,
 * as `marketplace.contextGraphId`: testnet names one; the mainnets name none,
 * as their chains have no marketplace contracts yet. It is the default for a
 * node whose own `marketplace` block sets no `contextGraphId`. A node that
 * sets one keeps it, an empty one included, which leaves the node without a
 * graph.
 */

/** The graph `network` names for the marketplace, or `undefined` when it names none. */
export function networkMarketplaceContextGraphId(network: object | null | undefined): string | undefined {
  // `NetworkConfig` doesn't declare the block: the file is read as it is, so its value is checked here.
  const id = (network as { marketplace?: { contextGraphId?: unknown } } | null | undefined)?.marketplace?.contextGraphId;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * `config` with the network's graph as `marketplace.contextGraphId` when the
 * node's own block sets none. A config without a `marketplace` block comes
 * back as it is, since its marketplace is off; the config passed in is never
 * changed.
 */
export function withNetworkMarketplaceContextGraph<T extends { marketplace?: unknown }>(
  config: T,
  network: object | null | undefined,
): T {
  const graph = networkMarketplaceContextGraphId(network);
  const own = config.marketplace;
  if (graph === undefined || typeof own !== 'object' || own === null || 'contextGraphId' in own) return config;
  return { ...config, marketplace: { ...own, contextGraphId: graph } };
}
