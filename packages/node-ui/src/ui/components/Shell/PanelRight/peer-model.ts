import type { AgentInfo, ConnectionRow, PeerInfo } from './types.js';

export function shortPeerId(peerId: string): string {
  return peerId.length > 12 ? peerId.slice(-8) : peerId;
}

export function shortAgentUri(uri: string): string {
  if (!uri) return '';
  const colonIdx = uri.lastIndexOf(':');
  const tail = colonIdx >= 0 ? uri.slice(colonIdx + 1) : uri;
  return tail.length > 10 ? tail.slice(-10) : tail || uri.slice(-8);
}

export function buildPeers(
  connections: ConnectionRow[],
  agents: AgentInfo[],
): {
  connected: PeerInfo[];
  recentlySeen: PeerInfo[];
  directCount: number;
  relayedCount: number;
} {
  // peerId → AgentInfo[] (preserves all agents per peer for the chip list).
  const agentsByPeer = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    if (!a.peerId) continue;
    const list = agentsByPeer.get(a.peerId) ?? [];
    list.push(a);
    agentsByPeer.set(a.peerId, list);
  }

  // peerId → { hasDirect, hasRelay, openedAt (earliest) }.
  const connByPeer = new Map<string, {
    hasDirect: boolean;
    hasRelay: boolean;
    openedAt: number | null;
  }>();
  for (const c of connections) {
    if (!c.peerId) continue;
    const prev = connByPeer.get(c.peerId) ?? { hasDirect: false, hasRelay: false, openedAt: null };
    const hasDirect = prev.hasDirect || c.transport === 'direct';
    const hasRelay = prev.hasRelay || c.transport === 'relayed';
    const openedAt = c.openedAt != null
      ? (prev.openedAt != null ? Math.min(prev.openedAt, c.openedAt) : c.openedAt)
      : prev.openedAt;
    connByPeer.set(c.peerId, { hasDirect, hasRelay, openedAt });
  }

  const pickName = (peerAgents: AgentInfo[]): string | undefined =>
    peerAgents.find((a) => a.name)?.name;
  const pickLastSeen = (peerAgents: AgentInfo[]): number | undefined =>
    peerAgents.reduce<number | undefined>(
      (acc, a) => (a.lastSeen != null && (acc == null || a.lastSeen > acc) ? a.lastSeen : acc),
      undefined,
    );

  const connected: PeerInfo[] = [];
  const connectedPeerIds = new Set<string>();
  // Phase 1a: peers from `/api/connections.connections[]` (the authoritative
  // signal — comes straight from libp2p `getConnections()`).
  for (const [peerId, c] of connByPeer) {
    const peerAgents = agentsByPeer.get(peerId) ?? [];
    connected.push({
      peerId,
      name: pickName(peerAgents),
      transport: c.hasDirect ? 'direct' : 'relayed',
      hasDirect: c.hasDirect,
      hasRelay: c.hasRelay,
      openedAt: c.openedAt,
      connected: true,
      lastSeen: pickLastSeen(peerAgents),
      agents: peerAgents,
    });
    connectedPeerIds.add(peerId);
  }
  // Phase 1b: graceful-degradation fallback. If `/api/connections` errors,
  // returns an older shape without a `connections[]` array, or briefly lags
  // `/api/agents`, the agents endpoint can still report `connectionStatus:
  // "connected"` for a peer that isn't in `connByPeer`. Synthesize an entry
  // from the agent record so the peer doesn't vanish during the transient
  // gap. Transport rolls up with the same any-direct-wins rule used for
  // real connection rows — today the daemon emits a single transport per
  // peerId (it's a peerId-keyed lookup at agent-chat.ts:551,556), so this
  // is defense-in-depth against any future change.
  for (const [peerId, peerAgents] of agentsByPeer) {
    if (connectedPeerIds.has(peerId)) continue;
    const connectedAgents = peerAgents.filter((a) => a.connectionStatus === 'connected');
    if (connectedAgents.length === 0) continue;
    const hasDirect = connectedAgents.some((a) => a.connectionTransport === 'direct');
    const hasRelay = connectedAgents.some((a) => a.connectionTransport === 'relayed');
    // Any-direct-wins on the displayed transport. Default to 'direct' when
    // neither flag is set (e.g. an agent reporting `connectionTransport: null`
    // — we have no signal, so don't downgrade the badge to relayed).
    const transport: 'direct' | 'relayed' = hasRelay && !hasDirect ? 'relayed' : 'direct';
    connected.push({
      peerId,
      name: pickName(peerAgents),
      transport,
      hasDirect,
      hasRelay,
      openedAt: null,
      connected: true,
      lastSeen: pickLastSeen(peerAgents),
      agents: peerAgents,
    });
    connectedPeerIds.add(peerId);
  }

  const recentlySeen: PeerInfo[] = [];
  for (const [peerId, peerAgents] of agentsByPeer) {
    if (connectedPeerIds.has(peerId)) continue;
    const lastSeen = pickLastSeen(peerAgents);
    if (lastSeen == null) continue;
    recentlySeen.push({
      peerId,
      name: pickName(peerAgents),
      // Transport is not meaningful for a peer we aren't connected to;
      // mark `direct` arbitrarily so the type stays narrow.
      transport: 'direct',
      hasDirect: false,
      hasRelay: false,
      openedAt: null,
      connected: false,
      lastSeen,
      agents: peerAgents,
    });
  }
  recentlySeen.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));

  const directCount = connected.filter((p) => p.transport === 'direct').length;
  return { connected, recentlySeen, directCount, relayedCount: connected.length - directCount };
}

export function networkPeerCardStatusClass(agent: Pick<AgentInfo, 'connectionStatus'>): 'connected' | 'offline' {
  return agent.connectionStatus === 'connected' ? 'connected' : 'offline';
}

