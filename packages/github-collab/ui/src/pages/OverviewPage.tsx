import React, { useState, useEffect } from 'react';
import { fetchStatus, fetchInfo } from '../api.js';
import { useRepo, repoKey } from '../context/RepoContext.js';

export function OverviewPage() {
  const { selectedRepo } = useRepo();
  const [status, setStatus] = useState<any>(null);
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchStatus().catch(() => null), fetchInfo().catch(() => null)])
      .then(([s, i]) => { setStatus(s); setInfo(i); })
      .catch(e => setError(e.message));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;

  // Filter repos to selected repo if one is selected
  const displayRepos = selectedRepo
    ? (status?.repos ?? []).filter((r: any) => r.repoKey === repoKey(selectedRepo))
    : (status?.repos ?? []);

  return (
    <div className="page">
      <h2 className="page-title">Overview</h2>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">DKG Status</div>
          <div className="stat-value">{info?.dkgEnabled ? 'Connected' : 'Offline'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Peer ID</div>
          <div className="stat-value mono">{info?.peerId ? info.peerId.slice(0, 16) + '...' : 'N/A'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Tracked Repos</div>
          <div className="stat-value">{status?.repos?.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Node Name</div>
          <div className="stat-value">{info?.nodeName ?? 'N/A'}</div>
        </div>
      </div>

      {displayRepos.length > 0 && (
        <div className="section">
          <h3>Configured Repositories</h3>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Paranet</th>
                  <th>Sync Status</th>
                  <th>Last Sync</th>
                </tr>
              </thead>
              <tbody>
                {displayRepos.map((r: any) => (
                  <tr key={r.repoKey}>
                    <td className="mono">{r.repoKey}</td>
                    <td className="mono">{r.paranetId}</td>
                    <td><span className={`badge badge-${r.syncStatus}`}>{r.syncStatus}</span></td>
                    <td>{r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString() : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {displayRepos.length === 0 && (
        <div className="empty-state">
          <p>No repositories configured yet.</p>
          <p>Go to <strong>Settings</strong> to add a GitHub repository.</p>
        </div>
      )}
    </div>
  );
}
