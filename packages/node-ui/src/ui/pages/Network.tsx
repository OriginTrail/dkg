import React from 'react';
import { useFetch, shortId, formatDuration } from '../hooks.js';
import { fetchConnections, fetchAgents } from '../api.js';
import { Badge } from '../components/ds/Badge.js';
import { humanizeStatus } from '../lib/formatLabels.js';
import { formatNodeRole } from '../lib/format.js';
import { Link2, UsersRound } from 'lucide-react';
import { EmptyState } from '../components/ContextGraphPrimitives.js';
import { StatTile } from '../components/ds/StatTile.js';

function ConnectionBadge({ agent: a }: { agent: any }) {
  if (a.connectionStatus === 'self') {
    return <Badge size="sm">Self</Badge>;
  }
  if (a.connectionStatus === 'connected') {
    const label = a.connectionTransport === 'relayed' ? 'Relayed' : 'Direct';
    const duration = a.connectedSinceMs ? ` · ${formatDuration(a.connectedSinceMs)}` : '';
    return (
      <Badge
        tone="success"
        size="sm"
        title={`${a.connectionDirection ?? ''} ${label.toLowerCase()} connection${duration}`}
      >
        {label}{duration}
      </Badge>
    );
  }
  return <Badge tone="danger" size="sm">Disconnected</Badge>;
}

export function NetworkConnections() {
  const { data: connData } = useFetch(fetchConnections, [], 10_000);
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);

  const connections = connData?.connections ?? [];
  const agents = agentData?.agents ?? [];

  return (
    <div className="network-tab">
      <div className="stats-grid">
        <StatTile label="Total connections" value={connData?.total ?? '—'} />
        <StatTile label="Direct" value={connData?.direct ?? '—'} />
        <StatTile label="Relayed" value={connData?.relayed ?? '—'} />
        <StatTile label="Known agents" value={agents.length} />
      </div>

      <div className="card ds-card">
        <div className="card-header"><div className="card-title">Active connections</div></div>
        {connections.length === 0 ? (
          <EmptyState compact inline icon={<Link2 size={16} />} title="No active connections" description="Connections will appear here as your node links with peers on the network." />
        ) : (
          <div className="ds-table-scroll ds-table-pin"><table className="data-table">
            <thead>
              <tr>
                <th>Peer</th>
                <th>Transport</th>
                <th>Direction</th>
                <th>Remote address</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{shortId(c.peerId, 12)}</td>
                  <td><Badge tone={c.transport === 'direct' ? 'success' : 'neutral'} size="sm">{humanizeStatus(String(c.transport))}</Badge></td>
                  <td>{c.direction}</td>
                  <td className="mono v10-network-id">{c.remoteAddr}</td>
                  <td>{formatDuration(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="card ds-card">
        <div className="card-header"><div className="card-title">Discovered agents</div></div>
        {agents.length === 0 ? (
          <EmptyState compact inline icon={<UsersRound size={16} />} title="No agents discovered" description="Agents will be listed here as they are discovered through the network." />
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Peer ID</th>
                <th>Framework</th>
                <th>Role</th>
                <th>Connection</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a: any, i: number) => (
                <tr key={i}>
                  <td className="v10-network-name">{a.name}</td>
                  <td className="mono">{shortId(a.peerId, 12)}</td>
                  <td>{a.framework ?? '—'}</td>
                  <td>{formatNodeRole(a.nodeRole)}</td>
                  <td><ConnectionBadge agent={a} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
