import React, { useState, useEffect } from 'react';
import { fetchPullRequests, fetchPullRequest, fetchIssues, fetchCommits } from '../api.js';
import { useRepo, repoKey } from '../context/RepoContext.js';

type SubTab = 'prs' | 'issues' | 'commits';

function EnshrineStatusBadge({ pr }: { pr: any }) {
  if (pr.ual) {
    return <span className="badge badge-enshrined">Enshrined</span>;
  }
  return <span className="badge badge-workspace">Workspace</span>;
}

function PrDetailPanel({ owner, repo, prNumber, onClose }: { owner: string; repo: string; prNumber: number; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchPullRequest(owner, repo, prNumber)
      .then(d => setDetail(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [owner, repo, prNumber]);

  const triples = detail?.triples ?? [];
  // Extract properties from triples
  const props: Record<string, string> = {};
  for (const t of triples) {
    const pred = String(t.p ?? t.predicate ?? '');
    const obj = String(t.o ?? t.object ?? '');
    const key = pred.split('#').pop() ?? pred.split('/').pop() ?? pred;
    if (!props[key]) props[key] = obj;
  }

  return (
    <div className="collab-card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>
          PR #{prNumber}{props.title ? `: ${props.title}` : ''}
        </h3>
        <button className="btn btn-small btn-secondary" onClick={onClose}>Close</button>
      </div>
      {loading ? (
        <p className="text-muted">Loading details...</p>
      ) : (
        <>
          <div className="detail-grid">
            {props.state && (
              <div className="detail-item">
                <span className="detail-label">State</span>
                <span className="detail-value"><span className={`badge badge-${props.state}`}>{props.state}</span></span>
              </div>
            )}
            {props.author && (
              <div className="detail-item">
                <span className="detail-label">Author</span>
                <span className="detail-value">{props.author}</span>
              </div>
            )}
            {props.createdAt && (
              <div className="detail-item">
                <span className="detail-label">Created</span>
                <span className="detail-value">{new Date(props.createdAt).toLocaleString()}</span>
              </div>
            )}
            {props.mergedAt && (
              <div className="detail-item">
                <span className="detail-label">Merged</span>
                <span className="detail-value">{new Date(props.mergedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
          {triples.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="text-muted" style={{ cursor: 'pointer' }}>All properties ({triples.length})</summary>
              <div className="table-container" style={{ marginTop: 8 }}>
                <table className="data-table">
                  <thead><tr><th>Predicate</th><th>Value</th></tr></thead>
                  <tbody>
                    {triples.map((t: any, i: number) => (
                      <tr key={i}>
                        <td className="mono truncate">{String(t.p ?? t.predicate ?? '')}</td>
                        <td className="mono truncate">{String(t.o ?? t.object ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <div style={{ marginTop: 12 }}>
            <a
              href={`https://github.com/${owner}/${repo}/pull/${prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-small btn-secondary"
            >
              View on GitHub
            </a>
          </div>
        </>
      )}
    </div>
  );
}

export function PrIssuePage() {
  const { selectedRepo } = useRepo();
  const [tab, setTab] = useState<SubTab>('prs');
  const [prs, setPrs] = useState<any[]>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [commits, setCommits] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPr, setSelectedPr] = useState<number | null>(null);

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

  const loadIssues = async (owner: string, repo: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchIssues(owner, repo);
      setIssues(result.issues ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadCommits = async (owner: string, repo: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCommits(owner, repo);
      setCommits(result.commits ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Auto-load when selected repo or tab changes
  useEffect(() => {
    if (!selectedRepo) {
      setPrs([]);
      setIssues([]);
      setCommits([]);
      return;
    }
    if (tab === 'prs') loadPRs(selectedRepo.owner, selectedRepo.repo);
    else if (tab === 'issues') loadIssues(selectedRepo.owner, selectedRepo.repo);
    else if (tab === 'commits') loadCommits(selectedRepo.owner, selectedRepo.repo);
  }, [selectedRepo ? repoKey(selectedRepo) : null, tab]);

  function handleRefresh() {
    if (!selectedRepo) return;
    if (tab === 'prs') loadPRs(selectedRepo.owner, selectedRepo.repo);
    else if (tab === 'issues') loadIssues(selectedRepo.owner, selectedRepo.repo);
    else if (tab === 'commits') loadCommits(selectedRepo.owner, selectedRepo.repo);
  }

  return (
    <div className="page">
      <h2 className="page-title">Pull Requests, Issues &amp; Commits</h2>

      {!selectedRepo && (
        <div className="empty-state">
          <p>Select a repository from the header to view pull requests.</p>
        </div>
      )}

      {selectedRepo && (
        <>
          <div className="explorer-tabs">
            <button className={`btn btn-small ${tab === 'prs' ? '' : 'btn-secondary'}`} onClick={() => setTab('prs')}>PRs</button>
            <button className={`btn btn-small ${tab === 'issues' ? '' : 'btn-secondary'}`} onClick={() => setTab('issues')}>Issues</button>
            <button className={`btn btn-small ${tab === 'commits' ? '' : 'btn-secondary'}`} onClick={() => setTab('commits')}>Commits</button>
          </div>

          <div className="input-row">
            <span className="mono" style={{ fontSize: 13 }}>{repoKey(selectedRepo)}</span>
            <button className="btn btn-small btn-secondary" onClick={handleRefresh} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </>
      )}

      {error && <div className="error-banner">{error}</div>}

      {/* PRs Tab */}
      {selectedRepo && tab === 'prs' && (
        <>
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
                  {prs.map((pr: any, i: number) => {
                    const num = pr.number ? Number(pr.number) : null;
                    return (
                      <tr
                        key={i}
                        style={{ cursor: num ? 'pointer' : undefined }}
                        className={selectedPr === num ? 'row-selected' : ''}
                        onClick={() => num && setSelectedPr(selectedPr === num ? null : num)}
                      >
                        <td>{pr.number ?? '\u2014'}</td>
                        <td>{pr.title ?? '\u2014'}</td>
                        <td><span className={`badge badge-${pr.state}`}>{pr.state ?? '\u2014'}</span></td>
                        <td>{pr.author ?? '\u2014'}</td>
                        <td>{pr.createdAt ? new Date(pr.createdAt).toLocaleDateString() : '\u2014'}</td>
                        <td><EnshrineStatusBadge pr={pr} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {selectedPr !== null && selectedRepo && (
            <PrDetailPanel
              owner={selectedRepo.owner}
              repo={selectedRepo.repo}
              prNumber={selectedPr}
              onClose={() => setSelectedPr(null)}
            />
          )}
          {prs.length === 0 && !loading && !error && (
            <div className="empty-state">
              <p>No pull requests found in the knowledge graph for this repository.</p>
            </div>
          )}
        </>
      )}

      {/* Issues Tab */}
      {selectedRepo && tab === 'issues' && (
        <>
          {issues.length > 0 && (
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
                  {issues.map((issue: any, i: number) => (
                    <tr key={i}>
                      <td>{issue.number ?? '\u2014'}</td>
                      <td>{issue.title ?? '\u2014'}</td>
                      <td><span className={`badge badge-${issue.state}`}>{issue.state ?? '\u2014'}</span></td>
                      <td>{issue.author ?? '\u2014'}</td>
                      <td>{issue.createdAt ? new Date(issue.createdAt).toLocaleDateString() : '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {issues.length === 0 && !loading && !error && (
            <div className="empty-state">
              <p>No issues found in the knowledge graph for this repository.</p>
            </div>
          )}
        </>
      )}

      {/* Commits Tab */}
      {selectedRepo && tab === 'commits' && (
        <>
          {commits.length > 0 && (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SHA</th>
                    <th>Message</th>
                    <th>Author</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c: any, i: number) => (
                    <tr key={i}>
                      <td className="mono">{c.sha ? c.sha.slice(0, 7) : '\u2014'}</td>
                      <td className="truncate">{c.message ?? '\u2014'}</td>
                      <td>{c.author ?? '\u2014'}</td>
                      <td>{c.committedAt ? new Date(c.committedAt).toLocaleDateString() : '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {commits.length === 0 && !loading && !error && (
            <div className="empty-state">
              <p>No commits found in the knowledge graph for this repository.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
