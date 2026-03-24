import React, { useState, useCallback } from 'react';
import { executeQuery } from '../api.js';
import { GraphCanvas } from '../components/GraphCanvas.js';

export function GraphExplorerPage() {
  const [tab, setTab] = useState<'visual' | 'sparql'>('visual');
  const [sparql, setSparql] = useState(
    'CONSTRUCT { ?s ?p ?o } WHERE { ?s a <https://ontology.dkg.io/ghcode#PullRequest> ; ?p ?o } LIMIT 200'
  );
  const [repo, setRepo] = useState('');
  const [triples, setTriples] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeQuery(sparql, repo || undefined);
      const data = result?.result;
      if (data?.triples) {
        setTriples(data.triples);
      } else if (data?.bindings) {
        setTriples(data.bindings);
      } else {
        setTriples([]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sparql, repo]);

  return (
    <div className="page">
      <h2 className="page-title">Graph Explorer</h2>

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
        <GraphCanvas repo={repo || undefined} />
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
              <input
                type="text"
                className="input"
                placeholder="Repository (optional)"
                value={repo}
                onChange={e => setRepo(e.target.value)}
              />
              <button className="btn" onClick={runQuery} disabled={loading}>
                {loading ? 'Running...' : 'Execute'}
              </button>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {triples.length > 0 && (
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
