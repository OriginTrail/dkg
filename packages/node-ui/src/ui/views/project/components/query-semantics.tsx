import React, { useId } from 'react';
import type { GetView } from '@origintrail-official/dkg-core';
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core/query-result';
import { HttpError } from '../../../http.js';
import { Badge } from '../../../components/ds/Badge.js';

// Users see `semantics: "merged"` as "Search across assets".

/** The memory a query runs in, and whether it searches across assets. */
export interface QueryViewOptions {
  readonly view?: GetView;
  readonly merged: boolean;
}

/** What identifies a query run: the same fields run the same request. */
export interface QueryRunIdentity {
  readonly sparql: string;
  readonly view?: GetView;
  readonly subGraphName?: string;
  readonly semantics?: ViewQuerySemantics;
}

const VIEW_LABELS: Readonly<Record<GetView, string>> = {
  'verifiable-memory': 'Published assets',
  'shared-working-memory': 'Shared memory',
  'working-memory': 'Private drafts',
};

export const SEARCH_ACROSS_ASSETS_HINT = 'On: one query can link facts from different assets. Off: each asset is searched on its own.';
export const DRAFTS_SEARCHED_TOGETHER = 'Drafts are searched together.';

/**
 * Whether a query in this memory chooses between searching across assets and
 * each asset on its own. Private drafts are always searched together, as the
 * query view has done before: there is no per-asset search to choose.
 */
export function searchesAcrossAssets(view: GetView | undefined): boolean {
  return view === 'verifiable-memory' || view === 'shared-working-memory';
}

export function sameQueryRun(a: QueryRunIdentity, b: QueryRunIdentity): boolean {
  return a.sparql === b.sparql && a.view === b.view && a.subGraphName === b.subGraphName && a.semantics === b.semantics;
}

/**
 * A run in Published assets or Shared memory says how to search it, so the
 * toggle holds whatever the node's default is: `merged` when on, `per-asset`
 * when off. Any other run says nothing and is searched as before.
 */
export function withSemantics<T extends QueryRunIdentity>(run: T, merged: boolean): T {
  return searchesAcrossAssets(run.view) ? { ...run, semantics: merged ? 'merged' : 'per-asset' } : run;
}

/** A refused search across assets, explained for the query view; any other error is returned as it is. */
export function explainMergedRefusal(error: unknown): unknown {
  const code = error instanceof HttpError ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (code === 'VIEW_NOT_READY') {
    return new Error('Search across assets is still getting ready for this memory. Try again shortly, or turn it off.');
  }
  if (code === 'SEMANTICS_UNSUPPORTED') {
    return new Error(`Search across assets doesn't apply to this query here (${(error as Error).message}). Turn it off to search each asset on its own.`);
  }
  return error;
}

/**
 * The memory a query runs in, and the "Search across assets" toggle for
 * Published assets and Shared memory. In Private drafts a line says the drafts
 * are searched together. A loaded saved query brings its own memory, so the
 * picker is fixed while it's loaded.
 */
export function QueryViewControls({ options, locked, onChange }: {
  options: QueryViewOptions;
  locked: boolean;
  onChange: (next: QueryViewOptions) => void;
}) {
  const hintId = useId();
  const view = options.view;
  return (
    <div className="v10-cg-query-options">
      <label className="v10-cg-query-option">
        <span>Search in</span>
        <select
          className="v10-form-input ds-input ds-sm"
          value={view ?? ''}
          disabled={locked}
          title={locked ? 'The loaded query sets its own memory.' : undefined}
          onChange={event => onChange({ ...options, view: (event.target.value || undefined) as GetView | undefined })}
        >
          <option value="">All graphs</option>
          {(Object.keys(VIEW_LABELS) as GetView[]).map(option => (
            <option key={option} value={option}>{VIEW_LABELS[option]}</option>
          ))}
        </select>
      </label>
      {searchesAcrossAssets(view) && (
        <>
          <label className="v10-cg-query-option v10-cg-query-merged">
            <input
              type="checkbox"
              checked={options.merged}
              aria-describedby={hintId}
              onChange={event => onChange({ ...options, merged: event.target.checked })}
            />
            <span>Search across assets</span>
          </label>
          <span className="v10-cg-query-merged-hint" id={hintId}>{SEARCH_ACROSS_ASSETS_HINT}</span>
        </>
      )}
      {view === 'working-memory' && <span className="v10-cg-query-merged-hint">{DRAFTS_SEARCHED_TOGETHER}</span>}
    </div>
  );
}

/** How the node searched Published assets or Shared memory: across assets, or each asset on its own. */
export function AnsweredSemantics({ view, semantics }: { view?: GetView; semantics?: ViewQuerySemantics }) {
  if (!searchesAcrossAssets(view) || semantics === undefined) return null;
  return (
    <Badge size="sm" className="v10-cg-query-answered" data-semantics={semantics}>
      {semantics === 'merged' ? 'Searched across assets' : 'Each asset searched on its own'}
    </Badge>
  );
}
