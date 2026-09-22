// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS,
} from '@origintrail-official/dkg-chain';
import { record } from './authority-index-snapshot-wire.js';

export const AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS = CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS;
export const AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS = 2_000;

export interface AuthorityIndexSnapshotConfig {
  readonly trustedCorePeers: readonly string[];
  readonly maxTailBlocks?: number;
}

export interface AuthorityIndexSnapshotPeer {
  readonly peerId: string;
  /** Dial address; absent for a discovered core reached over its live connection. */
  readonly multiaddr?: string;
}

export interface NormalizedAuthorityIndexSnapshotConfig {
  /** Explicit configuration always pins a dial address per identity. */
  readonly trustedCorePeers: readonly Required<AuthorityIndexSnapshotPeer>[];
  readonly maxTailBlocks: number;
}

/** Explicit identities only. Discovery or relay roles never enlarge this trust set. */
export function normalizeAuthorityIndexSnapshotConfig(
  config: unknown,
): NormalizedAuthorityIndexSnapshotConfig {
  const data = record(config);
  if (!data || !Array.isArray(data.trustedCorePeers)
    || data.trustedCorePeers.length === 0
    || data.trustedCorePeers.length > AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) {
    throw new Error(`Authority index trustedCorePeers must contain at least 1 and at most ${AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS} explicit multiaddrs`);
  }
  const maxTailBlocks = data.maxTailBlocks === undefined
    ? AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS
    : data.maxTailBlocks;
  if (typeof maxTailBlocks !== 'number' || !Number.isSafeInteger(maxTailBlocks)
    || maxTailBlocks < CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS
    || maxTailBlocks > CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS) {
    throw new Error(`Authority index maxTailBlocks must be an integer between ${CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS} and ${CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS}`);
  }
  const identities = new Set<string>();
  const peers = data.trustedCorePeers.map((raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_024) {
      throw new Error('Authority index trusted core must be an explicit multiaddr');
    }
    const parsed = multiaddr(raw);
    const components = parsed.getComponents();
    const last = components.at(-1);
    const circuitIndexes = components.flatMap((part, index) => part.name === 'p2p-circuit' ? [index] : []);
    const peerIndexes = components.flatMap((part, index) => part.name === 'p2p' ? [index] : []);
    const host = components[0];
    if (!host || !['ip4', 'ip6', 'dns', 'dns4', 'dns6'].includes(host.name)
      || !components.some((part) => part.name === 'tcp' || part.name === 'udp')
      || last?.name !== 'p2p' || !last.value
      || circuitIndexes.length > 1
      || (circuitIndexes.length === 0 && peerIndexes.length !== 1)
      || (circuitIndexes.length === 1 && (
        peerIndexes.length !== 2
        || peerIndexes[0] !== circuitIndexes[0] - 1
        || peerIndexes[1] !== circuitIndexes[0] + 1
      ))) {
      throw new Error('Authority index trusted core requires a host transport and unambiguous final /p2p/<peerId>');
    }
    // Canonicalize alternate encodings so one identity cannot count twice.
    const peerId = peerIdFromString(last.value).toString();
    if (identities.has(peerId)) throw new Error('Authority index trustedCorePeers contains a duplicate peer identity');
    identities.add(peerId);
    return Object.freeze({ peerId, multiaddr: parsed.toString() });
  });
  return Object.freeze({ trustedCorePeers: Object.freeze(peers), maxTailBlocks });
}
