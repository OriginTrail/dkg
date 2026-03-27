import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { executeQuery, fetchBranches } from '../api.js';
import { GraphCanvas } from '../components/GraphCanvas.js';
import { useRepo, repoKey } from '../context/RepoContext.js';

const ENTITY_TYPES = [
  'Repository', 'PullRequest', 'Issue', 'Commit', 'Branch',
  'File', 'Directory', 'Class', 'Function', 'User', 'Review',
];

function NodeDetailPanel({ nodeId, repo, onClose }: { nodeId: string; repo?: string; onClose: () => void }) {
  const [properties, setProperties] = useState<Array<{ p: string; o: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const sparql = `SELECT ?p ?o WHERE { <${nodeId}> ?p ?o } LIMIT 100`;
    executeQuery(sparql, repo)
      .then(result => {
        const bindings = result?.result?.bindings ?? [];
        setProperties(bindings.map((b: any) => ({
          p: String(b.p ?? ''),
          o: String(b.o ?? ''),
        })));
      })
      .catch(() => setProperties([]))
      .finally(() => setLoading(false));
  }, [nodeId, repo]);

  // Determine type from properties
  const rdfType = properties.find(p => p.p.includes('rdf-syntax-ns#type'));
  const typeName = rdfType?.o.split('#').pop() ?? rdfType?.o.split('/').pop() ?? '';

  // Check if it's a GitHub entity
  const isGitHub = nodeId.startsWith('urn:github:');
  let githubUrl: string | null = null;
  if (isGitHub) {
    const parts = nodeId.replace('urn:github:', '').split('/');
    if (parts.length >= 2) {
      const [owner, repoName, ...rest] = parts;
      if (rest[0] === 'pr') githubUrl = `https://github.com/${owner}/${repoName}/pull/${rest[1]}`;
      else if (rest[0] === 'issue') githubUrl = `https://github.com/${owner}/${repoName}/issues/${rest[1]}`;
      else if (rest[0] === 'commit') githubUrl = `https://github.com/${owner}/${repoName}/commit/${rest[1]}`;
      else if (rest.length === 0) githubUrl = `https://github.com/${owner}/${repoName}`;
    }
  }

  return (
    <div className="node-detail-panel">
      <div className="node-detail-header">
        <span className="node-detail-title">
          {typeName || 'Node'} Detail
        </span>
        <button className="btn btn-small btn-secondary" onClick={onClose}>Close</button>
      </div>
      <div className="node-detail-uri mono">{nodeId}</div>

      {loading ? (
        <p className="text-muted">Loading properties...</p>
      ) : properties.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <thead><tr><th>Predicate</th><th>Value</th></tr></thead>
            <tbody>
              {properties.map((row, i) => (
                <tr key={i}>
                  <td className="mono truncate">{row.p}</td>
                  <td className="mono truncate">{row.o}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted">No properties found for this node.</p>
      )}

      {githubUrl && (
        <div style={{ marginTop: 8 }}>
          <a href={githubUrl} target="_blank" rel="noopener noreferrer" className="btn btn-small btn-secondary">
            View on GitHub
          </a>
        </div>
      )}
    </div>
  );
}

export function GraphExplorerPage() {
  const { selectedRepo } = useRepo();
  const [tab, setTab] = useState<'visual' | 'sparql'>('visual');
  const [sparql, setSparql] = useState(
    'CONSTRUCT { ?s ?p ?o } WHERE { ?s a <https://ontology.dkg.io/ghcode#PullRequest> ; ?p ?o } LIMIT 200'
  );
  const [includeWorkspace, setIncludeWorkspace] = useState(true);
  const [triples, setTriples] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Branch selector state
  const [branches, setBranches] = useState<Array<{ name: string; protected: boolean }>>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState<string>('');

  // Graph sidebar state
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set(ENTITY_TYPES));
  const [searchText, setSearchText] = useState('');
  const [tripleCount, setTripleCount] = useState(0);
  const [graphLimit, setGraphLimit] = useState(500);
  const [graphLoading, setGraphLoading] = useState(false);

  // Node detail state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const scopedRepo = selectedRepo ? repoKey(selectedRepo) : undefined;

  // Load branches when repo changes, detect default branch
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([]);
      setDefaultBranch('');
      return;
    }
    setBranchesLoading(true);
    fetchBranches(selectedRepo.owner, selectedRepo.repo)
      .then(result => {
        const branchList = result.branches ?? [];
        setBranches(branchList);
        // Default to main or master if available
        const def = branchList.find((b: any) => b.name === 'main')
          ?? branchList.find((b: any) => b.name === 'master')
          ?? branchList[0];
        if (def) {
          setDefaultBranch(def.name);
          setSelectedBranch(def.name);
        }
      })
      .catch(() => {
        setBranches([]);
      })
      .finally(() => setBranchesLoading(false));
  }, [selectedRepo?.owner, selectedRepo?.repo]);

  const runQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTriples([]);
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Query timed out after 30 seconds. Try reducing the LIMIT or simplifying the query.')), 30_000)
      );
      const result = await Promise.race([
        executeQuery(sparql, scopedRepo, includeWorkspace),
        timeout,
      ]);
      const data = result?.result ?? result;
      const rows = data?.triples ?? data?.bindings ?? data?.quads ?? [];
      if (Array.isArray(rows) && rows.length > 0) {
        setTriples(rows);
      } else {
        setError('Query returned no results.');
      }
    } catch (e: any) {
      setError(e.message ?? 'Query execution failed');
    } finally {
      setLoading(false);
    }
  }, [sparql, scopedRepo, includeWorkspace]);

  const toggleTypeFilter = (type: string) => {
    setTypeFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="page page-wide">
      <h2 className="page-title">Graph Explorer</h2>

      {selectedRepo && (
        <div className="scope-banner">
          Scoped to <strong className="mono">{repoKey(selectedRepo)}</strong>
          {selectedRepo.paranetId && (
            <span className="text-muted" style={{ marginLeft: 8 }}>
              paranet: {selectedRepo.paranetId}
            </span>
          )}
        </div>
      )}

      {/* Branch Selector */}
      {selectedRepo && (
        <div className="input-row" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            Branch:
          </label>
          <select
            className="repo-select"
            style={{ minWidth: 200 }}
            value={selectedBranch}
            onChange={e => setSelectedBranch(e.target.value)}
            disabled={branchesLoading}
          >
            <option value="">All branches</option>
            {branches.map(b => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
          <span className="text-muted" style={{ marginTop: 0 }}>
            {defaultBranch ? `Default: ${defaultBranch}` : 'Select a branch to filter'}
          </span>
        </div>
      )}

      <div className="explorer-tabs">
        <button
          className={`btn btn-small ${tab === 'visual' ? '' : 'btn-secondary'}`}
          onClick={() => setTab('visual')}
        >
          Visual Graph
        </button>
        <button
          className={`btn btn-small ${tab === 'sparql' ? '' : 'btn-secondary'}`}
          onClick={() => setTab('sparql')}
        >
          SPARQL Query
        </button>
      </div>

      {tab === 'visual' && (
        <div className="graph-explorer-layout">
          <div className="graph-explorer-main">
            <GraphCanvas
              repo={scopedRepo}
              limit={graphLimit}
              searchText={searchText}
              onNodeClick={(nodeId) => setSelectedNodeId(nodeId)}
              onTripleCount={(count) => { setTripleCount(count); setGraphLoading(false); }}
              toolbar={
                <div className="graph-floating-toolbar">
                  <div className="graph-toolbar-pill">
                    <input
                      type="number"
                      className="graph-limit-input"
                      value={graphLimit}
                      min={1}
                      max={10000}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v > 0) {
                          setGraphLimit(v);
                          setGraphLoading(true);
                        }
                      }}
                    />
                    <span className="graph-triple-count">
                      limit ({graphLoading ? 'Loading...' : `${tripleCount} loaded`})
                    </span>
                  </div>
                  <button
                    className="graph-toolbar-pill graph-toolbar-toggle"
                    onClick={() => setShowFilters(prev => !prev)}
                  >
                    Types {showFilters ? '\u25B4' : '\u25BE'}
                  </button>
                  {showFilters && (
                    <div className="graph-filter-dropdown">
                      {ENTITY_TYPES.map(type => (
                        <label key={type} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={typeFilters.has(type)}
                            onChange={() => toggleTypeFilter(type)}
                          />
                          {type}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              }
            />

            {selectedNodeId && (
              <NodeDetailPanel
                nodeId={selectedNodeId}
                repo={scopedRepo}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
          </div>
        </div>
      )}

      {tab === 'sparql' && (
        <>
          <div className="query-panel">
            <textarea
              className="query-input"
              rows={4}
              value={sparql}
              onChange={e => setSparql(e.target.value)}
              placeholder="Enter SPARQL query..."
            />
            <div className="input-row">
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Repo: {scopedRepo ?? 'all'}
              </span>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includeWorkspace}
                  onChange={e => setIncludeWorkspace(e.target.checked)}
                />
                Include workspace data
              </label>
              <button className="btn" onClick={runQuery} disabled={loading}>
                {loading ? 'Running...' : 'Execute'}
              </button>
            </div>
          </div>

          {loading && (
            <div className="empty-state">
              <p>Executing query...</p>
              <p className="text-muted" style={{ marginTop: 4 }}>Timeout: 30 seconds</p>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          {!loading && triples.length > 0 && (
            <div className="section">
              <h3>{triples.length} result{triples.length !== 1 ? 's' : ''}</h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      {Object.keys(triples[0]).map(k => <th key={k}>{k}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {triples.slice(0, 100).map((row: any, i: number) => (
                      <tr key={i}>
                        {Object.values(row).map((v: any, j: number) => (
                          <td key={j} className="mono truncate">{String(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {triples.length > 100 && <p className="text-muted">Showing first 100 of {triples.length} results</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
