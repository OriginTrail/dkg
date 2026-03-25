import React, { useState, useCallback } from 'react';
import { RdfGraph } from '@origintrail-official/dkg-graph-viz/react';
import type { ViewConfig } from '@origintrail-official/dkg-graph-viz';
import { executeQuery } from '../api.js';
import { ALL_VIEWS } from '../lib/view-configs.js';

const VIEW_DESCRIPTIONS: Record<string, string> = {
  'code-structure': 'Classes, functions, files and their relationships (imports, inheritance, calls)',
  'dependency-flow': 'Package dependencies and module import chains',
  'pr-impact': 'Pull request changes mapped to affected code entities',
  'branch-diff': 'Visual diff of entities between two branches',
  'agent-activity': 'Active agents, their tasks, and claimed code regions',
};

interface GraphCanvasProps {
  repo?: string;
  branch?: string;
}

export function GraphCanvas({ repo, branch }: GraphCanvasProps) {
  const [viewKey, setViewKey] = useState('pr-impact');
  const [triples, setTriples] = useState<Array<{ subject: string; predicate: string; object: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const currentView = ALL_VIEWS[viewKey];

  const loadGraph = useCallback(async (view: ViewConfig) => {
    if (!view.defaultSparql) return;
    setLoading(true);
    setError(null);
    try {
      let sparql = view.defaultSparql;
      // If a branch is selected, inject a branch filter into the query
      if (branch) {
        const branchFilter = `FILTER(EXISTS { ?s <https://ontology.dkg.io/ghcode#branch> "${branch}" } || !BOUND(?s))`;
        // Insert branch filter before the closing brace and LIMIT
        sparql = sparql.replace(/}\s*(LIMIT\s+\d+)/i, `${branchFilter}\n} $1`);
      }
      const result = await executeQuery(sparql, repo || undefined);
      const data = result?.result;
      if (data?.quads && data.quads.length > 0) {
        // CONSTRUCT returns quads (with graph field)
        setTriples(data.quads.map((q: any) => ({ subject: q.subject, predicate: q.predicate, object: q.object })));
      } else if (data?.triples && data.triples.length > 0) {
        setTriples(data.triples);
      } else if (data?.bindings && data.bindings.length > 0) {
        // Convert bindings to triples if needed
        const rows = data.bindings
          .filter((b: any) => b.s && b.p && b.o)
          .map((b: any) => ({ subject: b.s, predicate: b.p, object: b.o }));
        setTriples(rows);
      } else {
        setTriples([]);
        setError('No data returned. The query may not match any entities in the workspace.');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [repo, branch]);

  // Auto-load PR Impact view when repo becomes available
  React.useEffect(() => {
    if (repo && !hasLoaded && currentView) {
      setHasLoaded(true);
      loadGraph(currentView);
    }
  }, [repo, hasLoaded, currentView, loadGraph]);

  const handleViewChange = (key: string) => {
    setViewKey(key);
    const view = ALL_VIEWS[key];
    if (view) loadGraph(view);
  };

  return (
    <div className="graph-canvas-container">
      <div className="graph-toolbar">
        <div className="view-selector">
          {Object.entries(ALL_VIEWS).map(([key, view]) => (
            <button
              key={key}
              className={`btn btn-small ${key === viewKey ? '' : 'btn-secondary'}`}
              onClick={() => handleViewChange(key)}
            >
              {view.name}
            </button>
          ))}
        </div>
        <button
          className="btn btn-small btn-secondary"
          onClick={() => currentView && loadGraph(currentView)}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {VIEW_DESCRIPTIONS[viewKey] && (
        <div className="view-description">{VIEW_DESCRIPTIONS[viewKey]}</div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="graph-viewport">
        {triples.length > 0 ? (
          <RdfGraph
            data={triples}
            format="triples"
            viewConfig={currentView}
            initialFit
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div className="graph-placeholder">
            {loading
              ? 'Loading graph data...'
              : 'Select a view and click Refresh to load graph data.'}
          </div>
        )}
      </div>
    </div>
  );
}
