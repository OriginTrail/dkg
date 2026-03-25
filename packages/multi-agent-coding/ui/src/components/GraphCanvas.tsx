import React, { useState, useCallback, useMemo, useRef } from 'react';
import { RdfGraph } from '@origintrail-official/dkg-graph-viz/react';
import type { RdfGraphVizConfig, ViewConfig } from '@origintrail-official/dkg-graph-viz';
import { executeQuery } from '../api.js';
import { ALL_VIEWS } from '../lib/view-configs.js';

const VIEW_DESCRIPTIONS: Record<string, string> = {
  'repo-overview': 'Repository structure with PRs, issues, branches, and contributors',
  'code-structure': 'Classes, functions, interfaces, methods, and type aliases',
  'dependency-flow': 'Import declarations and their source modules',
  'files': 'File tree structure with directories and files',
  'pr-impact': 'Pull request changes mapped to affected code entities',
  'branch-diff': 'Branches, commits, and merge history',
  'issues': 'Issue tracking with labels, milestones, and assignees',
  'agent-activity': 'Active agents, their tasks, and claimed code regions',
};

/** Graph viz options tuned for the GitHub collaboration views (500+ nodes) */
const GRAPH_OPTIONS: RdfGraphVizConfig = {
  labelMode: 'humanized',
  hexagon: {
    baseSize: 10,
    minSize: 5,
    maxSize: 24,
    scaleWithDegree: true,
  },
  style: {
    edgeWidth: 0.5,
    edgeArrowSize: 2,
    borderWidth: 0.8,
    fontSize: 10,
    gradient: true,
    gradientIntensity: 0.25,
  },
};

interface GraphCanvasProps {
  repo?: string;
  branch?: string;
  limit?: number;
  searchText?: string;
  onNodeClick?: (nodeId: string) => void;
  onTripleCount?: (count: number) => void;
  /** Optional floating toolbar rendered inside the graph viewport */
  toolbar?: React.ReactNode;
}

export function GraphCanvas({ repo, branch, limit = 500, searchText, onNodeClick, onTripleCount, toolbar }: GraphCanvasProps) {
  const [viewKey, setViewKey] = useState('pr-impact');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Cache triples per view key so switching tabs doesn't lose data
  const triplesCache = useRef<Record<string, Array<{ subject: string; predicate: string; object: string }>>>({});
  const [triples, setTriples] = useState<Array<{ subject: string; predicate: string; object: string }>>([]);

  const currentView = ALL_VIEWS[viewKey];

  const loadGraph = useCallback(async (view: ViewConfig, key: string) => {
    if (!view.defaultSparql) return;
    setLoading(true);
    setError(null);
    try {
      const sparql = view.defaultSparql.replace(/LIMIT\s+\d+/i, `LIMIT ${limit}`);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Query timed out after 30 seconds. Try reducing the limit.')), 30_000)
      );
      const result = await Promise.race([
        executeQuery(sparql, repo || undefined),
        timeout,
      ]);
      const data = result?.result;
      let parsed: Array<{ subject: string; predicate: string; object: string }> = [];
      if (data?.quads && data.quads.length > 0) {
        parsed = data.quads.map((q: any) => ({ subject: q.subject, predicate: q.predicate, object: q.object }));
      } else if (data?.triples && data.triples.length > 0) {
        parsed = data.triples;
      } else if (data?.bindings && data.bindings.length > 0) {
        parsed = data.bindings
          .filter((b: any) => b.s && b.p && b.o)
          .map((b: any) => ({ subject: b.s, predicate: b.p, object: b.o }));
      }
      triplesCache.current[key] = parsed;
      setTriples(parsed);
      onTripleCount?.(parsed.length);
      if (parsed.length === 0) {
        setError('No data returned. The query may not match any entities in the workspace.');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [repo, limit, onTripleCount]);

  // Auto-load PR Impact view when repo becomes available
  React.useEffect(() => {
    if (repo && !hasLoaded && currentView) {
      setHasLoaded(true);
      loadGraph(currentView, viewKey);
    }
  }, [repo, hasLoaded, currentView, viewKey, loadGraph]);

  const handleViewChange = (key: string) => {
    setViewKey(key);
    // Restore cached triples if available, otherwise fetch fresh
    const cached = triplesCache.current[key];
    if (cached && cached.length > 0) {
      setTriples(cached);
      setError(null);
      onTripleCount?.(cached.length);
    } else {
      const view = ALL_VIEWS[key];
      if (view) loadGraph(view, key);
    }
  };

  // Memoize options so RdfGraph doesn't remount on every render
  const graphOptions = useMemo(() => GRAPH_OPTIONS, []);

  // Filter triples by search text (matches subject/predicate/object URIs)
  const filteredTriples = useMemo(() => {
    if (!searchText || searchText.trim().length === 0) return triples;
    const q = searchText.toLowerCase();
    // Find matching node URIs first
    const matchingNodes = new Set<string>();
    for (const t of triples) {
      if (t.subject.toLowerCase().includes(q) || t.object.toLowerCase().includes(q)) {
        matchingNodes.add(t.subject);
        if (t.object.startsWith('http') || t.object.startsWith('urn:')) {
          matchingNodes.add(t.object);
        }
      }
    }
    // Keep all triples that involve a matching node
    return triples.filter(t => matchingNodes.has(t.subject) || matchingNodes.has(t.object));
  }, [triples, searchText]);

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
          onClick={() => currentView && loadGraph(currentView, viewKey)}
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
        {toolbar}
        {filteredTriples.length > 0 ? (
          <RdfGraph
            key={viewKey}
            data={filteredTriples}
            format="triples"
            options={graphOptions}
            viewConfig={currentView}
            initialFit
            onNodeClick={onNodeClick ? (node: any) => onNodeClick(node.id ?? node) : undefined}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div className="graph-placeholder">
            {loading
              ? 'Loading graph data...'
              : searchText && triples.length > 0
                ? 'No nodes match the current filter.'
                : hasLoaded
                  ? 'No data found for this view.'
                  : 'Select a view and click Refresh to load graph data.'}
          </div>
        )}
      </div>
    </div>
  );
}
