import React, { useState, useCallback } from 'react';
import { RdfGraph } from '@origintrail-official/dkg-graph-viz/react';
import type { ViewConfig } from '@origintrail-official/dkg-graph-viz';
import { executeQuery } from '../api.js';
import { ALL_VIEWS } from '../lib/view-configs.js';

interface GraphCanvasProps {
  repo?: string;
}

export function GraphCanvas({ repo }: GraphCanvasProps) {
  const [viewKey, setViewKey] = useState('pr-impact');
  const [triples, setTriples] = useState<Array<{ subject: string; predicate: string; object: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentView = ALL_VIEWS[viewKey];

  const loadGraph = useCallback(async (view: ViewConfig) => {
    if (!view.defaultSparql) return;
    setLoading(true);
    setError(null);
    try {
      const result = await executeQuery(view.defaultSparql, repo || undefined);
      const data = result?.result;
      if (data?.triples) {
        setTriples(data.triples);
      } else if (data?.bindings) {
        // Convert bindings to triples if needed
        const rows = data.bindings
          .filter((b: any) => b.s && b.p && b.o)
          .map((b: any) => ({ subject: b.s, predicate: b.p, object: b.o }));
        setTriples(rows);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [repo]);

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
