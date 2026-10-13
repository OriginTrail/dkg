import { createHash } from 'node:crypto';
import { peerIdFromRelayAddress } from '@origintrail-official/dkg-core';

/**
 * The network file's relays in the order one node takes them.
 *
 * An edge dials its relays in list order and libp2p hands the reservation
 * slots (three by default) to the first relays that answer. With one order for
 * every edge, the first three relays of the file hold every edge's
 * reservations and the rest hold none until one of the three is away. A
 * per-node order spreads the edges of a network evenly over all listed relays.
 *
 * The order ranks each relay by a hash of the node's key and the relay's peer
 * id (rendezvous hashing), so:
 *   - it is stable for a node across restarts, and addresses other nodes
 *     cached for it stay valid;
 *   - adding or removing a relay leaves the relative order of the others
 *     untouched, so a list change moves at most one reservation per node.
 *
 * Addresses of one relay (several transports) stay together, in file order.
 * Entries without a parseable peer id, such as the placeholders of a network
 * that is not deployed yet, keep file order after the rest.
 *
 * `nodeKey` is any value that is stable and unique for the node. It never
 * leaves the node; only the resulting choice of relays is visible.
 */
export function orderNetworkRelaysForNode(relays: readonly string[], nodeKey: string): string[] {
  const ranked: Array<{ relay: string; rank: string; index: number }> = [];
  const unparseable: string[] = [];
  relays.forEach((relay, index) => {
    const peerId = typeof relay === 'string' ? peerIdFromRelayAddress(relay) : undefined;
    if (peerId === undefined) {
      unparseable.push(relay);
      return;
    }
    const rank = createHash('sha256').update(`${nodeKey}\n${peerId}`).digest('hex');
    ranked.push({ relay, rank, index });
  });
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.index - b.index));
  return [...ranked.map(({ relay }) => relay), ...unparseable];
}

/**
 * The relay list a daemon without an explicit `relay` takes from its network
 * file. An edge uses its own order. A Core keeps file order: it has a public
 * address and does not depend on where its one reservation sits. Without a
 * node key the file order is kept as well.
 */
export function networkRelaysForNode(input: {
  relays: readonly string[];
  role: 'core' | 'edge';
  nodeKey: string | undefined;
}): string[] {
  if (input.role !== 'edge' || !input.nodeKey) return [...input.relays];
  return orderNetworkRelaysForNode(input.relays, input.nodeKey);
}
