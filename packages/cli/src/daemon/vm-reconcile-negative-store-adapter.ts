import {
  parseVmReconcileCleanMissPeerIds,
  parseVmReconcilePeerTopology,
  type VmReconcileNegativeRecord,
  type VmReconcilePeerTopology,
} from '@origintrail-official/dkg-agent';

/** Raw SQLite-facing DTO. Encoding is intentionally confined to this adapter. */
export interface VmReconcileNegativePersistenceRow {
  cache_key: string;
  context_graph_id: string;
  failures: number;
  next_retry_at: number;
  swm_gen: string;
  candidate_namespaces: string;
  peer_topology_key: string;
  updated_at: number;
}

const TOPOLOGY_VERSION = 2;

type DecodedTopology = Pick<
  VmReconcileNegativeRecord,
  'peerTopology' | 'cleanMissPeerIds'
>;

function decodeTopology(encoded: string): DecodedTopology | null {
  if (encoded === 'unreadable') {
    return { peerTopology: { kind: 'unreadable' }, cleanMissPeerIds: [] };
  }
  try {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (
      !(raw.preferredPeerId === null || typeof raw.preferredPeerId === 'string')
      || typeof raw.privateOnly !== 'boolean'
      || !Array.isArray(raw.peers)
      || !(raw.version === undefined || raw.version === 1 || raw.version === TOPOLOGY_VERSION)
    ) return null;

    const isLegacy = raw.version === undefined || raw.version === 1;
    const peers: unknown[] = [];
    if (isLegacy) {
      for (const [rank, candidate] of raw.peers.entries()) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        const peer = candidate as Record<string, unknown>;
        if (
          peer.rank !== rank
          || typeof peer.preferred !== 'boolean'
          || peer.preferred !== (peer.peerId === raw.preferredPeerId)
        ) return null;
        peers.push({ peerId: peer.peerId, core: peer.core });
      }
    } else {
      peers.push(...raw.peers);
    }

    const peerTopology = parseVmReconcilePeerTopology({
      kind: 'readable',
      preferredPeerId: raw.preferredPeerId,
      privateOnly: raw.privateOnly,
      peers,
    });
    if (!peerTopology) return null;
    const cleanMissPeerIds = isLegacy
      ? []
      : parseVmReconcileCleanMissPeerIds(raw.cleanMissPeerIds, peerTopology);
    return cleanMissPeerIds === null ? null : { peerTopology, cleanMissPeerIds };
  } catch {
    return null;
  }
}

function encodeTopology(
  topology: VmReconcilePeerTopology,
  cleanMissPeerIds: readonly string[],
): string {
  if (topology.kind === 'unreadable') return 'unreadable';
  return JSON.stringify({
    version: TOPOLOGY_VERSION,
    preferredPeerId: topology.preferredPeerId,
    privateOnly: topology.privateOnly,
    peers: topology.peers,
    cleanMissPeerIds,
  });
}

export function decodeVmReconcileNegativeRow(
  row: VmReconcileNegativePersistenceRow,
): VmReconcileNegativeRecord | null {
  try {
    const candidateNamespaces: unknown = JSON.parse(row.candidate_namespaces);
    const topology = decodeTopology(row.peer_topology_key);
    if (
      !Number.isInteger(row.failures)
      || row.failures <= 0
      || !Number.isFinite(row.next_retry_at)
      || !Array.isArray(candidateNamespaces)
      || !candidateNamespaces.every((item) =>
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof (item as Record<string, unknown>).metaGraph === 'string'
        && typeof (item as Record<string, unknown>).dataGraph === 'string')
      || !topology
    ) return null;
    return {
      cacheKey: row.cache_key,
      localCgId: row.context_graph_id,
      failures: row.failures,
      nextRetryAt: row.next_retry_at,
      swmGen: row.swm_gen,
      candidateNamespaces: candidateNamespaces as Array<{ metaGraph: string; dataGraph: string }>,
      peerTopology: topology.peerTopology,
      cleanMissPeerIds: topology.cleanMissPeerIds,
    };
  } catch {
    return null;
  }
}

export function encodeVmReconcileNegativeRow(
  record: VmReconcileNegativeRecord,
  updatedAt: number,
): VmReconcileNegativePersistenceRow {
  return {
    cache_key: record.cacheKey,
    context_graph_id: record.localCgId,
    failures: record.failures,
    next_retry_at: record.nextRetryAt,
    swm_gen: record.swmGen,
    candidate_namespaces: JSON.stringify(record.candidateNamespaces),
    peer_topology_key: encodeTopology(record.peerTopology, record.cleanMissPeerIds),
    updated_at: updatedAt,
  };
}
