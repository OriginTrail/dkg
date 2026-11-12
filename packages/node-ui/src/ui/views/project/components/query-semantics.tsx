import React from 'react';
import type { GetView } from '@origintrail-official/dkg-core';
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core/query-result';
import { HttpError } from '../../../http.js';

/** The view a query runs in, and whether it asks for merged answers. */
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
  'working-memory': 'Working memory',
  'shared-working-memory': 'Shared memory',
  'verifiable-memory': 'Verifiable memory',
};

export function sameQueryRun(a: QueryRunIdentity, b: QueryRunIdentity): boolean {
  return a.sparql === b.sparql && a.view === b.view && a.subGraphName === b.subGraphName && a.semantics === b.semantics;
}

/** The run with `semantics: "merged"` when merged answers are asked for and it has a view, which they need. */
export function withSemantics<T extends QueryRunIdentity>(run: T, merged: boolean): T {
  return merged && run.view !== undefined ? { ...run, semantics: 'merged' } : run;
}

/** A refused merged query, explained for the query console; any other error is returned as it is. */
export function explainMergedRefusal(error: unknown): unknown {
  const code = error instanceof HttpError ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (code === 'VIEW_NOT_READY') {
    return new Error('The merged view is not ready: its read graph is still being built or repaired. Try again shortly, or turn Merged off.');
  }
  if (code === 'SEMANTICS_UNSUPPORTED') {
    return new Error(`Merged answers don't apply to this query (${(error as Error).message}). Turn Merged off to match per asset.`);
  }
  return error;
}

/**
 * The view an ad-hoc query runs in, and the Merged toggle. A saved query
 * brings its own view, so the view is fixed while one is loaded. Merged
 * answers need a view.
 */
export function QueryViewControls({ options, locked, onChange }: {
  options: QueryViewOptions;
  locked: boolean;
  onChange: (next: QueryViewOptions) => void;
}) {
  const view = options.view;
  return (
    <div className="v10-cg-query-options">
      <label className="v10-cg-query-option">
        <span>View</span>
        <select
          className="v10-form-input"
          value={view ?? ''}
          disabled={locked}
          title={locked ? 'The loaded query sets its own view.' : undefined}
          onChange={event => onChange({ ...options, view: (event.target.value || undefined) as GetView | undefined })}
        >
          <option value="">No view</option>
          {(Object.keys(VIEW_LABELS) as GetView[]).map(option => (
            <option key={option} value={option}>{VIEW_LABELS[option]}</option>
          ))}
        </select>
      </label>
      <label
        className="v10-cg-query-option v10-cg-query-merged"
        title={view ? 'Match the query against the view\'s assets as one graph, so patterns can join across assets.' : 'Merged answers need a view.'}
      >
        <input
          type="checkbox"
          checked={options.merged && view !== undefined}
          disabled={view === undefined}
          onChange={event => onChange({ ...options, merged: event.target.checked })}
        />
        <span>Merged</span>
      </label>
    </div>
  );
}

/** How the node matched a view query's answer. */
export function AnsweredSemantics({ view, semantics }: { view?: GetView; semantics?: ViewQuerySemantics }) {
  if (view === undefined || semantics === undefined) return null;
  return (
    <span className="v10-cg-query-answered" data-semantics={semantics}>
      {semantics === 'merged' ? ' · matched merged' : ' · matched per asset'}
    </span>
  );
}
