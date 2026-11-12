import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GetView } from '@origintrail-official/dkg-core';
import { useFetch } from '../../../hooks.js';
import {
  READ_GRAPH_MODES,
  fetchReadGraphSettings,
  setReadGraphMode,
  type ReadGraphLayerSettings,
  type ReadGraphMode,
  type ReadGraphSettings,
} from '../../../read-graphs-api.js';

const LAYER_LABELS: Readonly<Record<GetView, string>> = {
  'working-memory': 'Working memory',
  'shared-working-memory': 'Shared memory',
  'verifiable-memory': 'Verifiable memory',
};

const MODE_LABELS: Readonly<Record<ReadGraphMode, string>> = { off: 'Off', build: 'Build', serve: 'Serve' };

const MODE_HINTS: Readonly<Record<ReadGraphMode, string>> = {
  off: 'Keep no read graph for this layer.',
  build: 'Build and maintain the read graph, without answering merged queries from it.',
  serve: 'Answer merged queries from the read graph once it is ready.',
};

const SWITCHED_OFF = 'The node\'s config switches read graphs off for every context graph.';

/** How often the panel reads the settings again while a read graph is being built or removed. */
export const READ_GRAPHS_POLL_MS = 15_000;

function stateCount(layer: ReadGraphLayerSettings): number {
  return Object.values(layer.states).reduce((sum, count) => sum + count, 0);
}

/** A layer whose read graphs are still changing: being built or repaired, or being removed. */
function inTransition(layer: ReadGraphLayerSettings): boolean {
  const held = stateCount(layer);
  if (layer.mode === 'off') return held > 0;
  if (layer.mode !== 'build' && layer.mode !== 'serve') return false;
  return held === 0 || held !== (layer.states.ready ?? 0);
}

/** The layer's read graphs in a few words: "ready", "1 building, 2 ready", or what is about to happen. */
export function readGraphStateText(layer: ReadGraphLayerSettings): string {
  const states = Object.entries(layer.states).filter(([, count]) => count > 0);
  if (states.length === 0) {
    return layer.mode === 'build' || layer.mode === 'serve' ? 'Waiting to be built' : 'No read graph';
  }
  const listed = states.length === 1 && states[0][1] === 1
    ? states[0][0]
    : states.map(([state, count]) => `${count} ${state}`).join(', ');
  const text = layer.mode === 'off' ? `${listed}, being removed` : listed;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a layer can't be switched to build or serve, if it can't. Off is always allowed. */
function switchOnBlocked(settings: ReadGraphSettings, layer: ReadGraphLayerSettings): string | undefined {
  if (!settings.enabled) return SWITCHED_OFF;
  if (settings.refused) return settings.refused.error;
  if (!layer.allowed) return 'The node\'s config doesn\'t allow read graphs on this layer.';
  return undefined;
}

/**
 * The read graphs of a context graph, per layer, with the node admin's switch
 * between off, build and serve. Only the node admin can read these settings,
 * so the section stays hidden for anyone else and on a node without them.
 */
export function ReadGraphsSection({ contextGraphId }: { contextGraphId: string }) {
  const headingId = useId();
  const [changed, setChanged] = useState<ReadGraphSettings | null>(null);
  const [pending, setPending] = useState<GetView | null>(null);
  const [confirming, setConfirming] = useState<GetView | null>(null);
  const [refusal, setRefusal] = useState<{ contextGraphId: string; view: GetView; message: string } | null>(null);
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
  // Read again while a layer is changing, so its states follow the builder. A hidden tab doesn't read.
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
    // Off drops the layer's read graphs, so it asks first.
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
        <span className="v10-po-section-title" id={headingId}>Read graphs</span>
      </header>
      <p className="v10-po-rg-desc">
        A read graph holds a layer&apos;s assets as one graph, so merged queries can join across them.
        Build keeps it current; Serve also answers merged queries from it.
      </p>
      {!settings ? (
        <div className="v10-po-rg-error" role="alert">
          <span>Read-graph settings are unavailable: {error}</span>
          <button type="button" className="v10-po-join-btn" onClick={() => refresh()}>Retry</button>
        </div>
      ) : (
        <>
          {notice && <p className="v10-po-rg-notice" role="note">{notice}</p>}
          <div className="v10-po-rg-list">
            {settings.layers.map(layer => {
              const label = LAYER_LABELS[layer.view];
              const blocked = switchOnBlocked(settings, layer);
              return (
                <div key={layer.view} className="v10-po-rg-row" data-layer={layer.view} data-mode={layer.mode ?? 'unknown'}>
                  <div className="v10-po-rg-main">
                    <div className="v10-po-join-info">
                      <span className="v10-po-join-name">{label}</span>
                      <span className="v10-po-rg-state" data-testid="read-graph-state">{readGraphStateText(layer)}</span>
                      <span className="v10-po-join-addr">
                        {layer.setHere ? 'Set for this context graph' : 'From the node\'s config'}
                        {layer.allowed ? '' : ' · not allowed on this node'}
                      </span>
                    </div>
                    <div className="v10-po-rg-modes" role="group" aria-label={`${label} read graphs`}>
                      {READ_GRAPH_MODES.map(mode => (
                        <button
                          key={mode}
                          type="button"
                          className="v10-po-rg-mode"
                          aria-pressed={layer.mode === mode}
                          title={mode !== 'off' && blocked ? blocked : MODE_HINTS[mode]}
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
                    <div className="v10-po-rg-confirm" role="group" aria-label={`Turn off ${label} read graphs`}>
                      <span>Turning this off drops the layer&apos;s read graphs. Building them again takes time.</span>
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
