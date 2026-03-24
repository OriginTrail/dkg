import React, { useState, useEffect } from 'react';
import { fetchPullRequests } from '../api.js';

export function PrIssuePage() {
  const [prs, setPrs] = useState<any[]>([]);
  const [repoKey, setRepoKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPRs = async (key: string) => {
    if (!key.includes('/')) return;
    const [owner, repo] = key.split('/');
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPullRequests(owner, repo);
      setPrs(result.pullRequests ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <h2 className="page-title">Pull Requests & Issues</h2>

      <div className="input-row">
        <input
          type="text"
          className="input"
          placeholder="owner/repo (e.g. OriginTrail/dkg-v9)"
          value={repoKey}
          onChange={e => setRepoKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadPRs(repoKey)}
        />
        <button className="btn" onClick={() => loadPRs(repoKey)} disabled={loading}>
          {loading ? 'Loading...' : 'Load PRs'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {prs.length > 0 && (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>State</th>
                <th>Author</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {prs.map((pr: any, i: number) => (
                <tr key={i}>
                  <td>{pr.number ?? '—'}</td>
                  <td>{pr.title ?? '—'}</td>
                  <td><span className={`badge badge-${pr.state}`}>{pr.state ?? '—'}</span></td>
                  <td>{pr.author ?? '—'}</td>
                  <td>{pr.createdAt ? new Date(pr.createdAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {prs.length === 0 && !loading && !error && (
        <div className="empty-state">
          <p>Enter a repository key above to load pull requests from the knowledge graph.</p>
        </div>
      )}
    </div>
  );
}
