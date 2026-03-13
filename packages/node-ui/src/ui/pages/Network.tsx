import React from 'react';
import { useFetch, shortId, formatDuration } from '../hooks.js';
import { fetchConnections, fetchAgents } from '../api.js';

function ConnectionBadge({ agent: a }: { agent: any }) {
  if (a.connectionStatus === 'self') {
    return <span className="badge" style={{ background: 'var(--text-muted)' }}>Self</span>;
  }
  if (a.connectionStatus === 'connected') {
    const label = a.connectionTransport === 'relayed' ? 'Relayed' : 'Direct';
    const duration = a.connectedSinceMs ? ` · ${formatDuration(a.connectedSinceMs)}` : '';
    return (
      <span
        className="badge badge-success"
        title={`${a.connectionDirection ?? ''} ${label.toLowerCase()} connection${duration}`}
      >
        {label}{duration}
      </span>
    );
  }
  return <span className="badge" style={{ background: 'var(--error)' }}>Disconnected</span>;
}

export function NetworkPage() {
  const { data: connData } = useFetch(fetchConnections, [], 10_000);
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);

  const connections = connData?.connections ?? [];
  const agents = agentData?.agents ?? [];

  return (
    <div>
      <h1 className="page-title">Network</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Connections</div>
          <div className="stat-value">{connData?.total ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Direct</div>
          <div className="stat-value">{connData?.direct ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Relayed</div>
          <div className="stat-value">{connData?.relayed ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Known Agents</div>
          <div className="stat-value">{agents.length}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Active Connections</div>
        {connections.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
            </div>
            <div className="empty-state-title">No active connections</div>
            <div className="empty-state-desc">Connections will appear here as your node links with peers on the network.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Peer</th>
                <th>Transport</th>
                <th>Direction</th>
                <th>Remote Address</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{shortId(c.peerId, 12)}</td>
                  <td><span className={`badge ${c.transport === 'direct' ? 'badge-success' : 'badge-info'}`}>{c.transport}</span></td>
                  <td>{c.direction}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{c.remoteAddr}</td>
                  <td>{formatDuration(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title">Discovered Agents</div>
        {agents.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <div className="empty-state-title">No agents discovered</div>
            <div className="empty-state-desc">Agents will be listed here as they are discovered through the network.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>PeerId</th>
                <th>Framework</th>
                <th>Role</th>
                <th>Connection</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{a.name}</td>
                  <td className="mono">{shortId(a.peerId, 12)}</td>
                  <td>{a.framework ?? '—'}</td>
                  <td>{a.nodeRole ?? '—'}</td>
                  <td><ConnectionBadge agent={a} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
