import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GetView } from '@origintrail-official/dkg-core';
import { useFetch } from '../../../hooks.js';
import { Badge, LayerGlyph, type BadgeTone } from '../../../components/ds/Badge.js';
import { Button } from '../../../components/ds/Button.js';
import { Loading } from '../../../components/ds/Loading.js';
import { RetryButton } from '../../../components/ds/RetryButton.js';
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

const LAYER_NAMES: Readonly<Record<GetView, { readonly name: string; readonly detail?: string; readonly glyph: 'wm' | 'swm' | 'vm' }>> = {
  'verifiable-memory': { name: 'Published assets', glyph: 'vm' },
  'shared-working-memory': { name: 'Shared memory', detail: 'Shared with your team.', glyph: 'swm' },
  'working-memory': { name: 'Private drafts', glyph: 'wm' },
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

/** How a memory's state draws: ready states as success, work under way as pending, and the rest as a muted tag. */
export function searchStateTone(layer: ReadGraphLayerSettings): BadgeTone {
  const text = searchStateText(layer);
  if (text === 'In use' || text === 'Ready to turn on') return 'success';
  if (text === 'Off' || text === 'Not known') return 'muted';
  return 'pending';
}

/** How many of something, in users' words: "1 asset", "12,400 assets". */
function counted(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** How many assets a memory's combined copy held at its last build: "12,400 assets". */
export function searchAssetsText(layer: ReadGraphLayerSettings): string | undefined {
  if (layer.members === undefined || layer.mode === 'off') return undefined;
  return counted(layer.members, 'asset', 'assets');
}

/**
 * How many facts a memory's combined copy held at its last build: "About
 * 1,204 facts, at its last build". Writes since then change it.
 */
export function searchSizeText(layer: ReadGraphLayerSettings): string | undefined {
  if (layer.triples === undefined || layer.mode === 'off') return undefined;
  return `About ${counted(layer.triples, 'fact', 'facts')}, at its last build`;
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
  const { data, error } = useFetch(() => fetchResultChanges(contextGraphId), [contextGraphId], 0,
    { scope: contextGraphId, retention: 'scope' });
  if (!data) {
    return error
      ? <p className="v10-po-rg-changes" role="status">The comparison isn't available: {error}</p>
      : <Loading label="Loading the comparison…" className="v10-po-rg-changes" />;
  }
  const since = data.since === undefined || Number.isNaN(Date.parse(data.since))
    ? ''
    : `Since ${new Date(data.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: `;
  return (
    <p className="v10-po-rg-changes" role="status">
      {data.compared === 0
        ? 'No queries compared yet. The node compares some of the queries people run on this context graph.'
        : `${since}${data.different} of ${data.compared} compared ${data.compared === 1 ? 'query' : 'queries'} would give different results.`}
    </p>
  );
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
  // Reads in flight: a poll waits for them, so a slow node's answer isn't dropped by the next poll.
  const reading = useRef(0);
  const { data, error, refresh } = useFetch(
    async () => {
      reading.current += 1;
      try {
        return await fetchReadGraphSettings(contextGraphId);
      } finally {
        reading.current -= 1;
      }
    },
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
    const timer = setInterval(() => { if (!document.hidden && reading.current === 0) refresh(); }, READ_GRAPHS_POLL_MS);
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
        <h2 className="v10-po-section-title" id={headingId}>Search across assets</h2>
      </header>
      <p className="v10-po-rg-desc"><strong>Preview:</strong> {PREVIEW}</p>
      <p className="v10-po-rg-desc"><strong>On:</strong> {ON}</p>
      <Button variant="ghost" size="sm" className="v10-po-rg-changes-toggle" aria-expanded={showChanges} onClick={() => setShowChanges(shown => !shown)}>
        How results would change
      </Button>
      {showChanges && <ResultChangesLine contextGraphId={contextGraphId} />}
      {!settings ? (
        <div className="v10-po-rg-error">
          <p role="alert">Search across assets settings are unavailable: {error}</p>
          <RetryButton onClick={() => refresh()} />
        </div>
      ) : (
        <>
          {notice && <p className="v10-po-rg-notice ds-card-nested" role="note">{notice}</p>}
          <div className="v10-po-rg-list">
            {settings.layers.map(layer => {
              const { name, detail, glyph } = LAYER_NAMES[layer.view];
              const blocked = switchOnBlocked(settings, layer);
              const size = searchSizeText(layer);
              const assets = searchAssetsText(layer);
              return (
                <div key={layer.view} className="v10-po-rg-row ds-card-nested" data-layer={layer.view} data-mode={layer.mode ?? 'unknown'}>
                  <div className="v10-po-rg-main">
                    <div className="v10-po-join-info">
                      <span className="v10-po-join-name v10-po-rg-name"><LayerGlyph layer={glyph} />{name}</span>
                      {detail && <span className="v10-po-rg-detail">{detail}</span>}
                      <span className="v10-po-rg-facts">
                        <Badge tone={searchStateTone(layer)} size="sm" data-testid="search-state">{searchStateText(layer)}</Badge>
                        {assets && <Badge size="sm" data-testid="search-assets">{assets}</Badge>}
                        {size && <Badge size="sm" data-testid="search-size">{size}</Badge>}
                        {!layer.allowed && <Badge tone="muted" size="sm" data-testid="search-not-allowed">Not allowed on this node</Badge>}
                      </span>
                      <span className="v10-po-rg-source">{layer.setHere ? 'Set for this context graph' : 'Node default'}</span>
                    </div>
                    <div className="ds-seg v10-po-rg-modes" role="group" aria-label={`Search across assets in ${name}`}>
                      {READ_GRAPH_MODES.map(mode => (
                        <button
                          key={mode}
                          type="button"
                          className="ds-seg-item"
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
                  {pending === layer.view && <Loading label="Applying…" className="v10-po-rg-status" />}
                  {confirming === layer.view && (
                    <div className="v10-po-rg-confirm" role="group" aria-label={`Turn off ${name}`}>
                      <span>Turning this off removes the combined copy. Getting it ready again takes time.</span>
                      <Button variant="danger" size="sm" onClick={() => void apply(layer.view, 'off')}>Turn off</Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  )}
                  {refusal?.contextGraphId === contextGraphId && refusal.view === layer.view && (
                    <p className="v10-po-rg-refusal" role="alert">{refusal.message}</p>
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
