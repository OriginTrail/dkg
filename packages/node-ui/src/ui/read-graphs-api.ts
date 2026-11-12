// A context graph's read-graph settings, which only the node admin reads and
// changes: `GET` and `PUT /api/store/read-graphs/settings`, and the node's
// comparison of sampled queries answered both ways
// (`GET /api/query/view-semantics-delta`). Every answer is decoded here, so the
// panel never reads the node's JSON itself. Users see the feature as "Search
// across assets"; the API keeps the engine words.

import type { GetView } from '@origintrail-official/dkg-core';
import { HttpError, authHeaders, getBoundedJson, requestLongMutation } from './http.js';

export const READ_GRAPH_SETTINGS_PATH = '/api/store/read-graphs/settings';
export const RESULT_CHANGES_PATH = '/api/query/view-semantics-delta';

export type ReadGraphMode = 'off' | 'build' | 'serve';
export const READ_GRAPH_MODES: readonly ReadGraphMode[] = ['off', 'build', 'serve'];

/** The layers in the order the panel lists them. */
export const READ_GRAPH_VIEWS: readonly GetView[] = ['verifiable-memory', 'shared-working-memory', 'working-memory'];

/** The node reads its read-graph states from the store, which can take a while on a busy node. */
const READ_TIMEOUT_MS = 30_000;

/** The read-graph status names a layer by its short label. */
const LAYER_OF_LABEL: Readonly<Record<string, GetView>> = {
  wm: 'working-memory',
  swm: 'shared-working-memory',
  vm: 'verifiable-memory',
};

/** One layer of a context graph. */
export interface ReadGraphLayerSettings {
  readonly view: GetView;
  /** The mode in force; `undefined` when the node did not say. */
  readonly mode?: ReadGraphMode;
  /** Whether the mode is set for this context graph, rather than coming from the node's config. */
  readonly setHere: boolean;
  /** Whether the node's policy lets this layer keep read graphs. */
  readonly allowed: boolean;
  /** How many of the layer's read graphs are in each state, for example `{ ready: 1 }`. */
  readonly states: Readonly<Record<string, number>>;
  /**
   * How far the layer's read graphs being built have got, from 0 to 1. The node
   * reports it for the one its builder is working on; the others count as not
   * started. Absent when the node reports it for none.
   */
  readonly progress?: number;
  /** How many triples the layer's read graphs hold, when the node says for each of them. */
  readonly triples?: number;
}

export interface ReadGraphSettings {
  readonly contextGraphId: string;
  /** False when the node's config switches read graphs off for every context graph. */
  readonly enabled: boolean;
  /** Why this node can't switch a layer on, when that holds for every layer. */
  readonly refused?: { readonly code?: string; readonly error: string };
  /** One entry per layer, in {@link READ_GRAPH_VIEWS} order. */
  readonly layers: readonly ReadGraphLayerSettings[];
}

/** `hidden`: the caller isn't the node admin, or the node has no settings to show. */
export type ReadGraphSettingsLoad = { readonly kind: 'hidden' } | { readonly kind: 'settings'; readonly settings: ReadGraphSettings };

/** How a context graph's sampled queries would have answered across assets. */
export interface ResultChanges {
  /** Queries the node ran both ways and compared. */
  readonly compared: number;
  /** Of those, the ones whose results would be different. */
  readonly different: number;
  /** When the node started comparing, once it has compared any. */
  readonly since?: string;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modeOf(value: unknown): ReadGraphMode | undefined {
  return READ_GRAPH_MODES.find(mode => mode === value);
}

function viewOf(value: unknown): GetView | undefined {
  return READ_GRAPH_VIEWS.find(view => view === value) ?? (typeof value === 'string' ? LAYER_OF_LABEL[value] : undefined);
}

/** A finite, non-negative number, or `undefined`. */
function amountOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function entryOf(body: unknown, contextGraphId: string): Record<string, unknown> | undefined {
  const entries = objectOf(body)?.contextGraphs;
  return (Array.isArray(entries) ? entries : []).map(objectOf).find(entry => entry?.contextGraphId === contextGraphId);
}

interface HeldReadGraph { readonly state: string; readonly progress?: number; readonly triples?: number }

/** A layer's read graphs by state, how far those being built have got, and how many triples they hold. */
function heldOf(held: readonly HeldReadGraph[]): Pick<ReadGraphLayerSettings, 'states' | 'progress' | 'triples'> {
  const states: Record<string, number> = {};
  for (const { state } of held) states[state] = (states[state] ?? 0) + 1;
  const building = held.filter(readGraph => readGraph.state === 'building');
  const progress = building.some(readGraph => readGraph.progress !== undefined)
    ? building.reduce((sum, readGraph) => sum + Math.min(1, readGraph.progress ?? 0), 0) / building.length
    : undefined;
  const triples = held.length > 0 && held.every(readGraph => readGraph.triples !== undefined)
    ? held.reduce((sum, readGraph) => sum + readGraph.triples!, 0)
    : undefined;
  return { states, ...(progress === undefined ? {} : { progress }), ...(triples === undefined ? {} : { triples }) };
}

/**
 * Decode a settings answer for one context graph. Fields this page doesn't
 * know are ignored, and a field the node left out shows as unknown: without
 * `effective`, the rows alone give the modes.
 */
export function decodeReadGraphSettings(body: unknown, contextGraphId: string): ReadGraphSettings {
  const answer = objectOf(body) ?? {};
  const policy = objectOf(answer.policy);
  const allowedLayers = Array.isArray(policy?.layers) ? policy.layers.map(viewOf) : undefined;
  const refused = objectOf(answer.refused);
  const entry = entryOf(body, contextGraphId);
  const rows = objectOf(entry?.layers);
  const effective = objectOf(objectOf(entry?.effective)?.layers);
  const held = new Map<GetView, HeldReadGraph[]>(READ_GRAPH_VIEWS.map(view => [view, []]));
  for (const readGraph of Array.isArray(entry?.readGraphs) ? entry.readGraphs : []) {
    const row = objectOf(readGraph);
    const view = viewOf(row?.layer);
    const state = row?.state;
    if (view === undefined || typeof state !== 'string' || state === '') continue;
    const progress = amountOf(row?.progress);
    const triples = amountOf(row?.triples);
    held.get(view)!.push({
      state,
      ...(progress === undefined ? {} : { progress }),
      ...(triples === undefined ? {} : { triples: Math.floor(triples) }),
    });
  }
  return {
    contextGraphId,
    enabled: policy?.enabled !== false,
    ...(typeof refused?.error === 'string'
      ? { refused: { error: refused.error, ...(typeof refused.code === 'string' ? { code: refused.code } : {}) } }
      : {}),
    layers: READ_GRAPH_VIEWS.map(view => {
      const setHere = modeOf(rows?.[view]);
      const mode = modeOf(effective?.[view]) ?? setHere;
      return {
        view,
        ...(mode === undefined ? {} : { mode }),
        setHere: setHere !== undefined,
        allowed: allowedLayers === undefined || allowedLayers.includes(view),
        ...heldOf(held.get(view)!),
      };
    }),
  };
}

/** Decode the comparison report for one context graph: queries compared, and those whose results would differ. */
export function decodeResultChanges(body: unknown, contextGraphId: string): ResultChanges {
  const summary = entryOf(body, contextGraphId);
  const kinds = objectOf(summary?.kinds);
  const count = (kind: string) => Math.floor(amountOf(kinds?.[kind]) ?? 0);
  const different = count('rows-added') + count('rows-removed-or-changed');
  const compared = different + count('none') + count('copies-removed');
  return { compared, different, ...(compared > 0 && typeof summary?.since === 'string' ? { since: summary.since } : {}) };
}

/** The settings of one context graph, or `hidden` for a caller who isn't the node admin (403) or a node without them (404). */
export async function fetchReadGraphSettings(contextGraphId: string): Promise<ReadGraphSettingsLoad> {
  try {
    const path = `${READ_GRAPH_SETTINGS_PATH}?contextGraphId=${encodeURIComponent(contextGraphId)}`;
    const body = await getBoundedJson<unknown>(path, READ_TIMEOUT_MS);
    return { kind: 'settings', settings: decodeReadGraphSettings(body, contextGraphId) };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return { kind: 'hidden' };
    throw error;
  }
}

/**
 * Set one layer's mode for a context graph, and answer the settings after the
 * node applied it. A refusal throws an {@link HttpError} whose message is the
 * node's own sentence for the operator.
 */
export async function setReadGraphMode(contextGraphId: string, view: GetView, mode: ReadGraphMode): Promise<ReadGraphSettings> {
  const body = await requestLongMutation<unknown>(READ_GRAPH_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ contextGraphId, layers: { [view]: mode } }),
  }, 'The node did not answer in time. The change may still apply: refresh to see the current settings.');
  return decodeReadGraphSettings(body, contextGraphId);
}

/** How the node's sampled queries on one context graph would have answered across assets. */
export async function fetchResultChanges(contextGraphId: string): Promise<ResultChanges> {
  const path = `${RESULT_CHANGES_PATH}?contextGraphId=${encodeURIComponent(contextGraphId)}`;
  return decodeResultChanges(await getBoundedJson<unknown>(path, READ_TIMEOUT_MS), contextGraphId);
}
