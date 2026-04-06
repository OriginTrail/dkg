import React, { useState } from 'react';
import { useFetch, shortId } from '../hooks.js';
import { fetchIntegrations, subscribeToContextGraph } from '../api.js';

export function IntegrationsPage() {
  const { data: integrations, loading, refresh } = useFetch(fetchIntegrations, [], 30_000);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [newContextGraphId, setNewContextGraphId] = useState('');

  const adapters = integrations?.adapters ?? [];
  const skills = integrations?.skills ?? [];
  const contextGraphs = integrations?.contextGraphs ?? [];

  const handleSubscribe = async (contextGraphId: string) => {
    if (!contextGraphId.trim()) return;
    setSubscribing(contextGraphId);
    try {
      await subscribeToContextGraph(contextGraphId.trim());
      refresh();
    } catch {
      // ignore
    } finally {
      setSubscribing(null);
    }
  };

  return (
    <div>
      <h1 className="page-title">Integrations</h1>

      <div className="card">
        <div className="card-title">Adapters</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Adapters connect this node to external frameworks (ElizaOS, OpenClaw). Enable/disable and configure via config file.
        </p>
        {adapters.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
            </div>
            <div className="empty-state-title">No adapters configured</div>
            <div className="empty-state-desc">Enable adapters in your node config to connect with external frameworks like ElizaOS or OpenClaw.</div>
          </div>
        ) : (
          <div className="context-graph-list">
            {adapters.map((a: any) => (
              <div key={a.id} className="context-graph-card">
                <h3>{a.name}</h3>
                <p>{a.description ?? a.id}</p>
                <span className={`badge ${a.enabled ? 'badge-success' : 'badge-warning'}`}>
                  {a.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Discovered Skills</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Skills offered by agents on the network (from the agents context graph).
        </p>
        {skills.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </div>
            <div className="empty-state-title">No skills discovered</div>
            <div className="empty-state-desc">Skills offered by network agents will appear here as peers are discovered.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Skill type</th>
                <th>PeerId</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{s.agentName ?? s.name ?? '—'}</td>
                  <td>{s.skillType ?? s.type ?? '—'}</td>
                  <td className="mono">{shortId(s.peerId ?? s.agentPeerId ?? '', 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title">Context Graph Subscriptions</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Subscribe to additional context graphs. Data will sync from peers.
        </p>
        <div className="filters" style={{ marginBottom: 16 }}>
          <input
            className="input input-mono"
            placeholder="Context Graph ID (e.g. testing)"
            value={newContextGraphId}
            onChange={e => setNewContextGraphId(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <button
            className="btn btn-primary"
            disabled={!newContextGraphId.trim() || subscribing !== null}
            onClick={() => handleSubscribe(newContextGraphId)}
          >
            {subscribing === newContextGraphId ? 'Subscribing…' : 'Subscribe'}
          </button>
        </div>
        {contextGraphs.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
            </div>
            <div className="empty-state-title">No context graph subscriptions</div>
            <div className="empty-state-desc">Use the form above to subscribe to a context graph. Data will sync from peers automatically.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Context Graph</th>
                <th>ID / URI</th>
              </tr>
            </thead>
            <tbody>
              {contextGraphs.map((p: any, i: number) => (
                <tr key={i}>
                  <td>{typeof p === 'string' ? p : p.name ?? p.id ?? p}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{typeof p === 'object' && p.uri ? p.uri : p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
