import React, { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatDuration } from './format.js';
import { buildPeers, shortAgentUri, shortPeerId } from './peer-model.js';
import type { AgentInfo, ConnectionRow, PeerInfo } from './types.js';

// Per-peer card: header + meta + agents-as-chips. Nodes are
// infrastructure; agents live on them. Up to 3 chips inline, with a
// "+N more" button that expands inline (card grows vertically).
function NetworkPeerCard({ peer }: { peer: PeerInfo }) {
  const [expanded, setExpanded] = useState(false);
  const chipsId = useId();
  const CHIP_BUDGET = 3;
  const statusClass: 'connected' | 'offline' = peer.connected ? 'connected' : 'offline';
  const displayName = peer.name?.trim() || shortPeerId(peer.peerId);
  const visibleAgents = expanded ? peer.agents : peer.agents.slice(0, CHIP_BUDGET);
  const transportLabel = peer.connected ? peer.transport : 'Disconnected';
  // Any-direct-wins means a peer reachable on direct + relay is
  // labelled "direct" — surface the raw availability in the tooltip
  // so the relay path isn't completely hidden.
  const transportTitle =
    peer.connected && peer.hasDirect && peer.hasRelay
      ? 'Direct + relay paths active — direct shown'
      : undefined;
  return (
    <div className={`v10-agent-card v10-peer-card ${statusClass}`}>
      <div className="v10-agent-card-header">
        <span className={`v10-agent-card-dot ${statusClass}`} />
        <span className="v10-peer-card-name">{displayName}</span>
        <span className="v10-agent-card-badge" title={transportTitle}>
          {transportLabel}
        </span>
      </div>
      <div className="v10-peer-card-meta">
        <span title={peer.peerId}>{shortPeerId(peer.peerId)}</span>
        {peer.connected && peer.openedAt != null && (
          <span>up {formatDuration(Date.now() - peer.openedAt)}</span>
        )}
        {!peer.connected && peer.lastSeen != null && (
          <span>{formatDuration(Date.now() - peer.lastSeen)} ago</span>
        )}
        {peer.agents.length > 0 && (
          <span>{peer.agents.length} agent{peer.agents.length === 1 ? '' : 's'}</span>
        )}
      </div>
      {peer.agents.length > 0 && (
        <ul
          id={chipsId}
          className="v10-peer-card-chips"
          aria-label={`Agents on ${displayName}`}
        >
          {visibleAgents.map((a, idx) => (
            <li
              key={a.agentUri || `${peer.peerId}:${idx}`}
              className="v10-peer-chip"
              title={a.agentUri || ''}
            >
              <span className="v10-peer-chip-label">
                {shortAgentUri(a.agentUri) || shortPeerId(a.peerId)}
              </span>
            </li>
          ))}
          {peer.agents.length > CHIP_BUDGET && (
            <li>
              <button
                type="button"
                className="v10-peer-chip-more"
                aria-expanded={expanded}
                aria-controls={chipsId}
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? 'Show less' : `+${peer.agents.length - CHIP_BUDGET} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function NetworkPeerGroup(props: {
  label: string;
  peers: PeerInfo[];
  expanded: boolean;
  onToggle: () => void;
  emptyMessage: string;
}) {
  const { label, peers, expanded, onToggle, emptyMessage } = props;
  return (
    <div className="v10-peer-group">
      <button
        type="button"
        className="v10-peer-group-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={14}
          className={`v10-peer-group-chevron ${expanded ? 'expanded' : ''}`}
          aria-hidden="true"
        />
        <span className="v10-peer-group-label">{label}</span>
        <span className="v10-peer-group-count">{peers.length}</span>
      </button>
      {expanded && (
        <div className="v10-peer-group-body">
          {peers.length === 0 ? (
            <div className="v10-agent-empty-state">{emptyMessage}</div>
          ) : (
            // One card per libp2p peerId — keying on peerId is now
            // safe and intended (the previous agent-axis dedup is gone).
            peers.map((peer) => (
              <NetworkPeerCard key={peer.peerId} peer={peer} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function NetworkTab(props: {
  peerAgents: AgentInfo[];
  /**
   * `/api/connections` totals + per-connection rows. Both are needed:
   *   - `total` drives the empty-state (libp2p has connections but
   *     `/api/agents` hasn't emitted records yet).
   *   - `rows` is the source of truth for the peer axis — grouped by
   *     peerId inside `buildPeers` to derive one card per peer.
   * Per-connection records may include the same peerId twice when a
   * peer is reachable via both direct + relay simultaneously;
   * `buildPeers` collapses those.
   */
  connections: { total: number; direct: number; relayed: number; rows: ConnectionRow[] };
  loading: boolean;
  onRefresh: () => void;
}) {
  const { peerAgents, connections, loading, onRefresh } = props;
  const [connectedExpanded, setConnectedExpanded] = useState(true);
  const [recentlySeenExpanded, setRecentlySeenExpanded] = useState(false);

  // Peer-axis derivation — one card per libp2p peerId. Replaces the
  // earlier agent-axis dedupe tower (which existed to merge same-agent
  // records across transports; that's no longer needed once peerId is
  // the grouping key). Recently-seen list is uncapped, sorted by
  // lastSeen desc.
  const { connected, recentlySeen, directCount, relayedCount } = buildPeers(
    connections.rows,
    peerAgents,
  );

  return (
    <div className="v10-agent-scroll-tab">
      <div className="v10-agents-summary">
        <span className="v10-agents-stat">
          {/* Dot reflects libp2p connectivity. Light it if either
              `/api/connections` reports peers OR our derived count is
              non-zero — so a brief skew between the two endpoints
              doesn't briefly show "disconnected" while data is in flight. */}
          <span className={`v10-agents-stat-dot ${connected.length > 0 || connections.total > 0 ? 'connected' : 'known'}`} />
          <span title="Unique libp2p peers connected to this node — matches the count in the header.">
            {connected.length} peer{connected.length === 1 ? '' : 's'}
          </span>
        </span>
        {/* Any-direct-wins per peer: a peer reachable on direct + relay
            simultaneously is bucketed as direct. The transport tooltip
            on each card surfaces the raw availability so the relay path
            isn't completely hidden. */}
        <span
          className="v10-agents-stat"
          title="Preferred transport per peer (peers reachable via direct + relay are bucketed under direct)"
        >
          {directCount} direct / {relayedCount} relayed
        </span>
        <button className="v10-agents-refresh" onClick={onRefresh} title="Refresh network peers">
          Refresh
        </button>
      </div>

      {loading && <p className="v10-agents-loading">Loading peers...</p>}
      {!loading && connected.length === 0 && recentlySeen.length === 0 && connections.total === 0 && (
        <div className="v10-agent-empty-state">No network peers detected yet.</div>
      )}
      {!loading && connected.length === 0 && connections.total > 0 && (
        // libp2p reports connections but we haven't yet derived peers
        // from the row data — surface the raw count so the panel
        // doesn't read as "no peers" when the node IS actually
        // connected.
        <div className="v10-agent-empty-state">
          Connected to {connections.total} peer{connections.total === 1 ? '' : 's'} (peer metadata syncing…).
        </div>
      )}
      {(connected.length > 0 || recentlySeen.length > 0) && (
        <>
          <NetworkPeerGroup
            label="Connected"
            peers={connected}
            expanded={connectedExpanded}
            onToggle={() => setConnectedExpanded((p) => !p)}
            emptyMessage="No peers currently connected."
          />
          <NetworkPeerGroup
            label="Recently seen"
            peers={recentlySeen}
            expanded={recentlySeenExpanded}
            onToggle={() => setRecentlySeenExpanded((p) => !p)}
            emptyMessage="No previously-seen peers."
          />
        </>
      )}
    </div>
  );
}



