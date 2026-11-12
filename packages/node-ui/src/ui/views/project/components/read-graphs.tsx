import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GetView } from '@origintrail-official/dkg-core';
import { useFetch } from '../../../hooks.js';
import {
  READ_GRAPH_MODES,
  fetchReadGraphSettings,
  fetchResultChanges,
  setReadGraphMode,
  type ReadGraphLayerSettings,
  type ReadGraphMode,
  type ReadGraphSettings,
} from '../../../read-graphs-api.js';

// Users see read graphs as "Search across assets": each memory is Off, in
// Preview (the node keeps a combined copy, which no query reads yet) or On
// (queries that ask for it read the combined copy).

const LAYER_NAMES: Readonly<Record<GetView, { readonly name: string; readonly detail?: string }>> = {
  'verifiable-memory': { name: 'Published assets' },
  'shared-working-memory': { name: 'Shared memory', detail: 'Shared with your team' },
  'working-memory': { name: 'Private drafts' },
};

const MODE_LABELS: Readonly<Record<ReadGraphMode, string>> = { off: 'Off', build: 'Preview', serve: 'On' };

const PREVIEW = 'Prepares the combined copy and shows how results would change, without changing any results yet.';
const ON = 'Lets queries that ask for it search across assets.';
const MODE_HINTS: Readonly<Record<Exclude<ReadGraphMode, 'off'>, string>> = { build: PREVIEW, serve: ON };

const SWITCHED_OFF = 'This node\'s config switches search across assets off for every context graph.';
const NOT_ALLOWED = 'This node\'s config doesn\'t allow it for this memory.';

/** How often the panel reads the settings again while a memory is getting ready, being checked or rebuilt. */
export const READ_GRAPHS_POLL_MS = 15_000;

function heldCount(layer: ReadGraphLayerSettings): number {
  return Object.values(layer.states).reduce((sum, count) => sum + count, 0);
}

/** A memory that is on or in preview, and not ready yet. */
function inTransition(layer: ReadGraphLayerSettings): boolean {
  if (layer.mode !== 'build' && layer.mode !== 'serve') return false;
  const held = heldCount(layer);
  return held === 0 || held !== (layer.states.ready ?? 0);
}

/**
 * A memory's state in users' words: Off, Getting ready (with how far when the
 * node says), Rebuilding, Checking, In use or Ready to turn on.
 */
export function searchStateText(layer: ReadGraphLayerSettings): string {
  if (layer.mode === 'off') return 'Off';
  if (layer.mode === undefined) return 'Not known';
  const states = layer.states;
  const held = heldCount(layer);
  if (held === 0 || (states.building ?? 0) > 0) {
    return layer.progress === undefined ? 'Getting ready' : `Getting ready ${Math.min(99, Math.floor(layer.progress * 100))}%`;
  }
  if ((states.rebuilding ?? 0) + (states.repairing ?? 0) > 0) return 'Rebuilding';
  if ((states.ready ?? 0) === held) return layer.mode === 'serve' ? 'In use' : 'Ready to turn on';
  return 'Checking';
}

/**
 * How much a memory's combined copy holds, in users' words: "Holds about 1,204
 * facts". The node counts when a build ends, and writes since then change it.
 */
export function searchSizeText(layer: ReadGraphLayerSettings): string | undefined {
  if (layer.triples === undefined || layer.mode === 'off') return undefined;
  return `Holds about ${layer.triples.toLocaleString()} ${layer.triples === 1 ? 'fact' : 'facts'}`;
}

/** Why a memory can't be switched to Preview or On, if it can't. Off is always allowed. */
function switchOnBlocked(settings: ReadGraphSettings, layer: ReadGraphLayerSettings): string | undefined {
  if (!settings.enabled) return SWITCHED_OFF;
  if (settings.refused) return settings.refused.error;
  if (!layer.allowed) return NOT_ALLOWED;
  return undefined;
}

/** The node's comparison of this context graph's sampled queries, answered both ways. */
function ResultChangesLine({ contextGraphId }: { contextGraphId: string }) {
  const { data, error, loading } = useFetch(() => fetchResultChanges(contextGraphId), [contextGraphId], 0,
    { scope: contextGraphId, retention: 'scope' });
  let text: string;
  if (data) {
    const since = data.since === undefined || Number.isNaN(Date.parse(data.since))
      ? ''
      : `Since ${new Date(data.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: `;
    text = data.compared === 0
      ? 'No queries compared yet. The node compares some of the queries people run on this context graph.'
      : `${since}${data.different} of ${data.compared} compared ${data.compared === 1 ? 'query' : 'queries'} would give different results.`;
  } else {
    text = error ? `The comparison isn't available: ${error}` : loading ? 'Loading the comparison…' : '';
  }
  return <p className="v10-po-rg-changes" role="status">{text}</p>;
}

/**
 * Search across assets for a context graph: each memory's state, and the node
 * admin's switch between Off, Preview and On. Only the node admin can read
 * these settings, so the section stays hidden for anyone else and on a node
 * without them.
 */
export function ReadGraphsSection({ contextGraphId }: { contextGraphId: string }) {
  const headingId = useId();
  const [changed, setChanged] = useState<ReadGraphSettings | null>(null);
  const [pending, setPending] = useState<GetView | null>(null);
  const [confirming, setConfirming] = useState<GetView | null>(null);
  const [refusal, setRefusal] = useState<{ contextGraphId: string; view: GetView; message: string } | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const { data, error, refresh } = useFetch(
    () => fetchReadGraphSettings(contextGraphId),
    [contextGraphId],
    0,
    { scope: contextGraphId, retention: 'scope' },
  );

  // The view can move to another context graph while a change is under way:
  // its answer and its refusal show only on the context graph it was for.
  useEffect(() => {
    setPending(null);
    setConfirming(null);
  }, [contextGraphId]);
  // A read that lands after a change replaces the change's own answer.
  useEffect(() => { setChanged(null); }, [data]);
  // A change reads again through the loader of the context graph shown when it ends.
  const reread = useRef(refresh);
  useEffect(() => { reread.current = refresh; }, [refresh]);

  const settings = (changed?.contextGraphId === contextGraphId ? changed : null) ?? (data?.kind === 'settings' ? data.settings : null);
  // Read again while a memory is changing, so its state follows the node. A hidden tab doesn't read.
  const changing = settings?.layers.some(inTransition) ?? false;
  useEffect(() => {
    if (!changing) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, READ_GRAPHS_POLL_MS);
    return () => clearInterval(timer);
  }, [changing, refresh]);

  const apply = useCallback(async (view: GetView, mode: ReadGraphMode) => {
    setConfirming(null);
    setRefusal(null);
    setPending(view);
    try {
      const next = await setReadGraphMode(contextGraphId, view, mode);
      setChanged(next);
      reread.current();
    } catch (err) {
      setRefusal({ contextGraphId, view, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  }, [contextGraphId]);

  const choose = useCallback((layer: ReadGraphLayerSettings, mode: ReadGraphMode) => {
    if (layer.mode === mode) return;
    // Off drops the combined copy, so it asks first.
    if (mode === 'off' && (layer.mode === 'build' || layer.mode === 'serve')) {
      setRefusal(null);
      setConfirming(layer.view);
      return;
    }
    void apply(layer.view, mode);
  }, [apply]);

  if (data?.kind === 'hidden') return null;
  if (!settings && !error) return null;

  const notice = settings && !settings.enabled ? SWITCHED_OFF : settings?.refused?.error;

  return (
    <section className="v10-po-join v10-po-read-graphs" data-section="read-graphs" aria-labelledby={headingId}>
      <header className="v10-po-join-head">
        <span className="v10-po-section-title" id={headingId}>Search across assets</span>
      </header>
      <p className="v10-po-rg-desc">
        <strong>Preview:</strong> Prepares the combined copy and{' '}
        <button type="button" className="v10-po-rg-link" aria-expanded={showChanges} onClick={() => setShowChanges(shown => !shown)}>
          shows how results would change
        </button>, without changing any results yet.
      </p>
      {showChanges && <ResultChangesLine contextGraphId={contextGraphId} />}
      <p className="v10-po-rg-desc"><strong>On:</strong> {ON}</p>
      {!settings ? (
        <div className="v10-po-rg-error" role="alert">
          <span>Search across assets settings are unavailable: {error}</span>
          <button type="button" className="v10-po-join-btn" onClick={() => refresh()}>Retry</button>
        </div>
      ) : (
        <>
          {notice && <p className="v10-po-rg-notice" role="note">{notice}</p>}
          <div className="v10-po-rg-list">
            {settings.layers.map(layer => {
              const { name, detail } = LAYER_NAMES[layer.view];
              const blocked = switchOnBlocked(settings, layer);
              const size = searchSizeText(layer);
              return (
                <div key={layer.view} className="v10-po-rg-row" data-layer={layer.view} data-mode={layer.mode ?? 'unknown'}>
                  <div className="v10-po-rg-main">
                    <div className="v10-po-join-info">
                      <span className="v10-po-join-name">{name}</span>
                      <span className="v10-po-rg-state">
                        <span data-testid="search-state">{searchStateText(layer)}</span>
                        {size && <span data-testid="search-size"> · {size}</span>}
                      </span>
                      <span className="v10-po-rg-source">
                        {[detail, layer.setHere ? 'Set for this context graph' : 'Node default', layer.allowed ? undefined : 'not allowed on this node']
                          .filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <div className="v10-po-rg-modes" role="group" aria-label={`Search across assets in ${name}`}>
                      {READ_GRAPH_MODES.map(mode => (
                        <button
                          key={mode}
                          type="button"
                          className="v10-po-rg-mode"
                          aria-pressed={layer.mode === mode}
                          title={mode === 'off' ? undefined : blocked ?? MODE_HINTS[mode]}
                          disabled={pending !== null || (mode !== 'off' && blocked !== undefined)}
                          onClick={() => choose(layer, mode)}
                        >
                          {MODE_LABELS[mode]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {pending === layer.view && <div className="v10-po-rg-status" role="status">Applying…</div>}
                  {confirming === layer.view && (
                    <div className="v10-po-rg-confirm" role="group" aria-label={`Turn off ${name}`}>
                      <span>Turning this off removes the combined copy. Getting it ready again takes time.</span>
                      <button type="button" className="v10-po-join-btn reject" onClick={() => void apply(layer.view, 'off')}>Turn off</button>
                      <button type="button" className="v10-po-join-btn" onClick={() => setConfirming(null)}>Cancel</button>
                    </div>
                  )}
                  {refusal?.contextGraphId === contextGraphId && refusal.view === layer.view && (
                    <div className="v10-po-rg-refusal" role="alert">{refusal.message}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
