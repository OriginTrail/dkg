import React, { useState, useEffect } from 'react';
import { fetchPullRequests } from '../api.js';
import { useRepo, repoKey } from '../context/RepoContext.js';

function EnshrineStatusBadge({ pr }: { pr: any }) {
  // If the PR has a UAL, it's been enshrined on-chain
  if (pr.ual) {
    return <span className="badge badge-enshrined">Enshrined</span>;
  }
  // Otherwise it's workspace-only data
  return <span className="badge badge-workspace">Workspace</span>;
}

export function PrIssuePage() {
  const { selectedRepo } = useRepo();
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPRs = async (owner: string, repo: string) => {
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

  // Auto-load when selected repo changes
  useEffect(() => {
    if (selectedRepo) {
      loadPRs(selectedRepo.owner, selectedRepo.repo);
    } else {
      setPrs([]);
    }
  }, [selectedRepo ? repoKey(selectedRepo) : null]);

  return (
    <div className="page">
      <h2 className="page-title">Pull Requests & Issues</h2>

      {!selectedRepo && (
        <div className="empty-state">
          <p>Select a repository from the header to view pull requests.</p>
        </div>
      )}

      {selectedRepo && (
        <div className="input-row">
          <span className="mono" style={{ fontSize: 13 }}>
            {repoKey(selectedRepo)}
          </span>
          <button className="btn btn-small btn-secondary" onClick={() => loadPRs(selectedRepo.owner, selectedRepo.repo)} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      )}

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
                <th>Graph</th>
              </tr>
            </thead>
            <tbody>
              {prs.map((pr: any, i: number) => (
                <tr key={i}>
                  <td>{pr.number ?? '\u2014'}</td>
                  <td>{pr.title ?? '\u2014'}</td>
                  <td><span className={`badge badge-${pr.state}`}>{pr.state ?? '\u2014'}</span></td>
                  <td>{pr.author ?? '\u2014'}</td>
                  <td>{pr.createdAt ? new Date(pr.createdAt).toLocaleDateString() : '\u2014'}</td>
                  <td><EnshrineStatusBadge pr={pr} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRepo && prs.length === 0 && !loading && !error && (
        <div className="empty-state">
          <p>No pull requests found in the knowledge graph for this repository.</p>
        </div>
      )}
    </div>
  );
}
